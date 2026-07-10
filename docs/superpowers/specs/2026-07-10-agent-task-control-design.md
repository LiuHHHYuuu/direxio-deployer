# Direxio Agent Task Control and Hosted Search Design

Date: 2026-07-10

## Status

Approved design. Implementation has not started.

## Problem

The product agent currently delegates tool selection and completion entirely to
the model through LangChain `createAgent` with automatic tool choice. A plain
assistant response ends the loop even when the response only promises future
work, such as "I will check that for you." This creates three product failures:

- requests that require current external information can finish without a tool;
- the App may receive a promise instead of the requested result;
- adding more tools does not make completion more reliable because no component
  verifies that the required evidence was obtained.

The first implementation must solve this class of failure for current public
information. Weather is an eval case, not a permanent top-level task type.

## Goals

- Add a task-control layer around the existing LangChain runtime.
- Distinguish direct answers, external-evidence requests, and requests missing
  required information.
- Require successful external evidence before answering freshness-sensitive
  questions.
- Use owner memory to fill durable parameters such as the user's city.
- Reject empty promises and retry final answer generation at most once.
- Preserve the single outbound App message invariant.
- Replace the current DuckDuckGo Instant Answer dependency with hosted Tavily
  search without distributing the Tavily key to user-managed nodes.
- Establish a reusable capability and evidence contract for future tools.

## Non-goals

- A dedicated weather task type or weather API.
- A full custom LangGraph state machine.
- A model call that plans every ordinary chat turn.
- Autonomous side-effecting actions.
- Card selection, card personalization, or card UI changes. Those form the next
  design phase after task control is deployed and verified.
- Sending intermediate progress, tool JSON, retries, or errors as chat messages.

## Design Principles

1. Classify requirements, not product domains.
2. Program code enforces hard completion requirements; the model provides
   interpretation, optional tool decisions, and natural-language expression.
3. A tool call is not success. Valid tool evidence is success.
4. Intermediate state stays inside the runtime. The App receives one final
   response.
5. User-managed nodes receive Direxio credentials, not provider secrets.
6. The first version is bounded: one tool transport retry and one answer retry.

## Architecture

The existing `LangChainAgentRuntime` remains the only production conversation
runtime. A controller wraps its current `createAgent` invocation:

```text
User message
  -> TaskPlanner
  -> ParameterResolver
  -> Required tool execution, when applicable
  -> EvidenceLedger
  -> Existing LangChain agent
  -> CompletionValidator
  -> One bounded answer retry, when applicable
  -> One final outbound App message
```

The controller does not create a second message route. It returns through the
same `AgentRuntimeResult` consumed by the existing product-agent and
message-server bridge.

## Task Plan

```ts
type TaskPlanMode = "direct" | "external_evidence" | "clarify";

interface TaskPlan {
  mode: TaskPlanMode;
  requiredCapabilities: string[];
  searchQuery?: string;
  missingFields?: string[];
  reason: string;
}
```

Examples:

```ts
// "What is the weather in Shanghai tomorrow?"
{
  mode: "external_evidence",
  requiredCapabilities: ["fresh_information"],
  searchQuery: "Shanghai weather tomorrow",
  reason: "The answer depends on current public information."
}
```

```ts
// "What is the weather tomorrow?" with no location memory
{
  mode: "clarify",
  requiredCapabilities: ["fresh_information"],
  missingFields: ["location"],
  reason: "A location is required before searching."
}
```

### First-version planner

The first version uses deterministic, high-confidence requirement rules. It
recognizes explicit search requests and freshness signals such as current,
latest, today, tomorrow, news, public prices, scores, and weather. These are
signals that map to `external_evidence`; they are not task enum values.

Messages outside the high-confidence rules remain `direct` and continue through
the existing agent. A future model-assisted planner may handle ambiguous cases,
but it is not required for this version and must not add latency to every chat
turn.

## Parameter Resolution

Before returning `clarify`, the controller attempts to resolve missing fields
from relevant owner memory. Location uses the existing canonical key:

```text
profile.location.city
```

The automatic-memory privacy policy remains authoritative. A city mentioned in
a weather query is not durable evidence of residence and must not be saved as
the user's city. Only a durable user statement can create or update this owner
memory.

If no location is available, the controller returns one concise clarification
question and does not call search.

## Tool Capability Contract

Tools gain optional metadata that the controller can inspect without depending
on concrete tool names:

```ts
interface AgentToolCapabilities {
  capabilities: string[];
  produces: string[];
}
```

The first hosted search tool declares:

```ts
{
  capabilities: ["public_web", "fresh_information"],
  produces: ["search_results", "sources"]
}
```

Future tools can declare more specific capabilities. For example, a structured
weather tool may declare both `weather` and `fresh_information`. The controller
can prefer the more specific tool and fall back to hosted web search without
changing `TaskPlanMode`.

## Evidence Ledger

Every tool execution in the turn records normalized evidence:

```ts
interface ToolEvidence {
  toolName: string;
  capabilities: string[];
  ok: boolean;
  content: string;
  sources: string[];
}
```

The ledger includes controller-required calls and model-selected calls. It is
in-memory turn state only. It is not sent as an App message and is not written
to long-term memory.

For an `external_evidence` plan, completion requires at least one successful
evidence record that satisfies every required capability. A transport success
with empty or invalid results is recorded as unsuccessful evidence.

## Hosted Tavily Search

The Tavily provider key is stored only in the Direxio cloud gateway:

```text
User-managed product-agent
  -> POST https://ai.direxio.com/v1/tools/web-search
  -> Direxio gateway authenticates DIREXIO_AI_TOKEN
  -> Gateway reads TAVILY_API_KEY
  -> Tavily Search API
  -> Gateway normalizes results
  -> Product-agent records evidence
  -> Model produces the final answer
```

The endpoint accepts a bounded query and returns a provider-neutral response:

```ts
interface HostedSearchResponse {
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    publishedAt?: string;
  }>;
}
```

Limits for the first version:

- at most five results returned to the product-agent;
- bounded query, title, URL, and snippet lengths;
- gateway timeout and one retry for timeout or retryable `5xx` responses;
- no Tavily key, provider diagnostics, or raw provider payload in responses;
- per-token rate limits and structured operational logs;
- no search query or result persisted as automatic long-term memory.

The product-agent calls the hosted endpoint through the existing authenticated
gateway relationship. Local and unit tests use an injected mock provider.

## Execution Loop

1. Store the incoming message in current thread context, preserving the current
   behavior.
2. Build a `TaskPlan` from the latest user message.
3. Resolve missing plan fields from owner memory.
4. If required fields remain missing, return one clarification response.
5. Resolve a tool whose metadata satisfies the required capabilities.
6. Execute the required tool before final answer generation.
7. Record normalized success or failure in the evidence ledger.
8. Invoke the existing LangChain agent with the plan and evidence in runtime
   context. The agent may call additional tools.
9. Capture all additional tool evidence through the existing tool wrapper.
10. Validate the candidate final answer against the plan and ledger.
11. If validation fails and valid evidence exists, retry answer generation once
    with the validation failure and evidence.
12. Return one final success or failure response through the existing runtime
    result.
13. Run automatic memory only against the user message and accepted final reply.

## Completion Validation

The validator is deterministic in the first version. It rejects a candidate
when any of these conditions hold:

- a required capability has no successful evidence;
- external evidence is empty or structurally invalid;
- the answer is empty;
- the answer contains only a future-work promise such as "I will check," "let
  me look that up," or "please wait";
- the answer claims that search was unavailable when successful search evidence
  exists.

The validator does not judge prose quality or factual correctness beyond the
available evidence contract. Those belong in evals and later evidence-grounding
improvements.

## Failure Behavior

- Missing required parameter: one clarification question, no tool call.
- Hosted search timeout or retryable `5xx`: retry transport once.
- Search still fails: return one concise unavailable response; do not invoke the
  model to invent an answer.
- Search returns no usable results: return one concise no-result response.
- Valid evidence plus empty-promise model answer: retry answer generation once.
- Second invalid answer: return one deterministic failure response.
- Model-call budget reached: preserve the existing bounded runtime failure.
- All intermediate errors remain logs and runtime state, not chat messages.

## Single-message Invariant

No planner result, tool result, evidence item, retry prompt, JSON payload, or
intermediate answer is dispatched through message-server. Only the accepted
final `AgentRuntimeResult` is bridged to the App. Structured card output remains
unchanged and outside this work.

## Observability

When runtime logging is enabled, add structured events for:

- `agent_task_plan` with mode and required capabilities;
- `agent_required_tool` with tool name, success, and duration;
- `agent_completion_validation` with pass/fail reason;
- `agent_answer_retry` with retry count;
- hosted search request outcome, duration, result count, and request id.

Logs must omit user tokens, provider keys, full search results, and memory text.

## Testing and Evals

### Unit tests

- freshness signals create an external-evidence plan;
- normal stable questions remain direct;
- explicit search requests require public-web evidence;
- location is resolved from `profile.location.city` owner memory;
- a city mentioned only in a query is not saved as owner location;
- tool capability matching does not depend on a weather task enum;
- invalid and empty tool responses do not satisfy completion;
- empty promises are rejected;
- retries are bounded to one;
- automatic memory excludes evidence and intermediate output.

### Contract tests

- product-agent sends the correct authenticated hosted-search request;
- gateway normalizes Tavily output into `HostedSearchResponse`;
- provider key and raw payload never appear in gateway responses;
- retryable provider failure retries once;
- rate limits and invalid tokens return stable error envelopes.

### Runtime eval cases

| Input | Setup | Required result |
| --- | --- | --- |
| `What is the weather in Shanghai tomorrow?` | Search mock succeeds | Search runs and one concrete final answer is returned. |
| `What is the weather tomorrow?` | Owner city is Shanghai | Search uses Shanghai without clarification. |
| `What is the weather tomorrow?` | No owner city | One city clarification is returned and search does not run. |
| `What is the latest AI news?` | Search mock succeeds | Search runs and sources are available to the final answer. |
| `Explain a TypeScript interface.` | No special setup | Search is not forced. |
| Weather query | Hosted search returns `500` twice | One concise failure is returned; no fabricated weather or JSON appears. |
| Fresh query | First model answer is `I will check.` | Validator rejects it and one answer retry occurs. |
| Fresh query | Model remains invalid after retry | One deterministic failure is returned; no third attempt occurs. |

The final verification must include product-agent typecheck, focused unit and
contract tests, build, local smoke tests, and one deployed App check proving
that a single user message produces exactly one final Agent message.

## Expected Code Boundaries

Implementation should remain inside agent-owned code and avoid unrelated
application changes. Expected modules are:

- new runtime task-plan, evidence-ledger, and completion-validator modules;
- focused changes to `runtime/langchain-runtime.ts` for orchestration;
- additive capability metadata on agent tools;
- a hosted-search client in product-agent;
- a hosted-search route/provider adapter in the agent gateway;
- focused tests and eval fixtures;
- environment/config documentation for `TAVILY_API_KEY` on the gateway only.

Message-server and Flutter behavior should not change for this phase because
the existing single-result bridge is retained.

## Rollout

1. Land planner, evidence, validator, and mock-search tests behind a runtime flag.
2. Add the hosted gateway route and Tavily provider configuration.
3. Run local unit, contract, build, and smoke verification.
4. Deploy the gateway, then one product-agent test node.
5. Run the listed live weather, news, failure, and single-message checks.
6. Enable the controller by default after the test node passes.
7. Begin the separate intelligent-card design and implementation phase.
