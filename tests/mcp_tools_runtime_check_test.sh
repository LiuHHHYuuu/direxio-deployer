#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export HOME="$tmp/home"
mkdir -p "$HOME"

fakebin="$tmp/bin"
mkdir -p "$fakebin"
cat > "$fakebin/direxio-mcp" <<'EOF'
#!/usr/bin/env node
const requiredCred = process.env.EXPECTED_CREDENTIALS_FILE;
if (process.env.DIREXIO_CREDENTIALS_FILE !== requiredCred) {
  console.error("wrong DIREXIO_CREDENTIALS_FILE");
  process.exit(1);
}

const responses = [
  {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-direxio-mcp", version: "0.0.0" }
    }
  },
  {
    jsonrpc: "2.0",
    id: 2,
    result: {
      tools: [
        { name: "search_rooms", description: "Search rooms" },
        { name: "send_message", description: "Send message" },
        { name: "list_messages", description: "List messages" }
      ]
    }
  }
];

for (const response of responses) {
  const body = JSON.stringify(response);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
EOF
chmod 700 "$fakebin/direxio-mcp"

service_dir="$HOME/.direxio/nodes/mcp-tools.example.test"
mkdir -p "$service_dir"
credentials="$service_dir/credentials.json"
: > "$credentials"
state="$service_dir/state.json"
jq -n \
  --arg service_dir "$service_dir" \
  --arg credentials "$credentials" \
  '{
    run_id: "mcp-tools-test",
    region: "ap-northeast-1",
    domain_mode: "user",
    domain: "mcp-tools.example.test",
    agent_service_id: "mcp-tools.example.test",
    agent_service_dir: $service_dir,
    agent_credentials_file: $credentials,
    mcp_credentials_file: $credentials,
    mcp_command: "direxio-mcp",
    phase: "S7_VERIFY_E2E",
    phases: {
      S0_PREREQ_AWS: {status: "done"},
      S1_PREFLIGHT: {status: "done"},
      S2_DOMAIN: {status: "done"},
      S3_PROVISION: {status: "done"},
      S4_BOOTSTRAP_STACK: {status: "done"},
      S5_INIT_TOKENS: {status: "done"},
      S6_WIRE_LOCAL: {status: "done"},
      S7_VERIFY_E2E: {status: "done"}
    },
    resources: {}
  }' > "$state"

verify_output=$(P2P_WORKDIR="$service_dir" PATH="$fakebin:$PATH" EXPECTED_CREDENTIALS_FILE="$credentials" bash "$ROOT/scripts/orchestrate.sh" verify mcp_tools)
printf '%s\n' "$verify_output" | grep -q 'verified runtime check: mcp_tools'

jq -e '
  .runtime_checks.mcp_tools.status == "passed"
  and .runtime_checks.mcp_tools.tool_count == 3
  and (.runtime_checks.mcp_tools.tools | index("search_rooms") != null)
  and (.runtime_checks.mcp_tools.tools | index("send_message") != null)
  and (.runtime_checks.mcp_tools.tools | index("list_messages") != null)
  and (.user_confirmations.agent_mcp_runtime | not)
' "$state" >/dev/null

report_output=$(P2P_WORKDIR="$service_dir" bash "$ROOT/scripts/orchestrate.sh" report new_deploy)
report_path=$(printf '%s\n' "$report_output" | sed -nE 's/^operation report: //p' | tail -n 1)
jq -e '
  .runtime_checks.mcp_tools.status == "passed"
  and .runtime_checks.mcp_tools.tool_count == 3
  and .gates.user_confirmation.agent_mcp_runtime == "pending_runtime_confirmation"
' "$report_path" >/dev/null

echo "mcp tools runtime check ok"
