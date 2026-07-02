# Product Agent Prototype

This directory contains the product-agent-owned MVP surface for the hosted Direxio AI design. It is intentionally separate from the existing deployer, `cc-connect`, and MCP wiring.

## Scope

Owned here:

- `agent-service`: the self-hosted node service that receives product AI conversation events and calls the hosted gateway.
- `ai-gateway`: the Direxio-hosted service that validates Direxio AI tokens and calls model providers.
- Protocol and error mapping between those two services.

Not owned here:

- Mobile app implementation.
- `message-server` internals.
- Shared deployer orchestration and cloud-init.
- Existing `cc-connect` bridge behavior.
- Existing MCP tooling.

## Local Contract Test

Run the isolated contract test:

```bash
node tests/product_agent_contract_test.mjs
```

The test starts in-process HTTP servers and does not call real model providers.

## Prototype Servers

Start a local gateway with a test token:

```bash
DIREXIO_AI_GATEWAY_TOKENS=dxai_test node product-agent/bin/ai-gateway.mjs
```

Start a local agent service that uses that gateway:

```bash
DIREXIO_AI_TOKEN=dxai_test \
DIREXIO_AI_GATEWAY_URL=http://127.0.0.1:8787 \
node product-agent/bin/agent-service.mjs
```

The prototype `agent-service` accepts product AI conversation events at:

```http
POST /v1/agent/messages
Content-Type: application/json
```

It forwards only AI conversation messages, plus explicitly authorized selected context, to the hosted gateway.
