#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export HOME="$tmp/home"
mkdir -p "$HOME"

fakebin="$tmp/bin"
mkdir -p "$fakebin"

cat > "$fakebin/direxio-connect" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "daemon" ]
[ "${2:-}" = "status" ]
[ "${3:-}" = "--service-name" ]
[ "${4:-}" = "runtime-summary.example.test" ]
cat <<STATUS
cc-connect daemon status

  Status:    Running
  Platform:  test
  WorkDir:   ${CONNECT_WORK_DIR:-}
STATUS
EOF
chmod 700 "$fakebin/direxio-connect"

cat > "$fakebin/direxio-mcp" <<'EOF'
#!/usr/bin/env node
const requiredCred = process.env.EXPECTED_CREDENTIALS_FILE;
if (process.env.DIREXIO_CREDENTIALS_FILE !== requiredCred) {
  console.error("wrong DIREXIO_CREDENTIALS_FILE");
  process.exit(1);
}

if (process.argv[2] === "doctor" && process.argv[3] === "--json") {
  console.log(JSON.stringify({
    ok: true,
    domain: "runtime-summary.example.test",
    agent_room_id: "!agent:runtime-summary.example.test",
    token: "redacted"
  }));
  process.exit(0);
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
        { name: "search_rooms" },
        { name: "send_message" },
        { name: "list_messages" }
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

cat > "$fakebin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
body_path=""
write_code=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) body_path=$2; shift 2 ;;
    -w) write_code=1; shift 2 ;;
    *) shift ;;
  esac
done
payload='{"room_id":"!agent:runtime-summary.example.test","messages":[]}'
if [ -n "$body_path" ]; then
  printf '%s\n' "$payload" > "$body_path"
else
  printf '%s\n' "$payload"
fi
[ "$write_code" -eq 1 ] && printf '200'
EOF
chmod 700 "$fakebin/curl"

service_dir="$HOME/.direxio/nodes/runtime-summary.example.test"
mkdir -p "$service_dir/cc-connect"
credentials="$service_dir/credentials.json"
config="$service_dir/cc-connect/config.toml"
: > "$credentials"
: > "$config"
state="$service_dir/state.json"
jq -n \
  --arg service_dir "$service_dir" \
  --arg credentials "$credentials" \
  --arg config "$config" \
  '{
    run_id: "runtime-summary-test",
    region: "ap-northeast-1",
    domain_mode: "user",
    domain: "runtime-summary.example.test",
    as_url: "https://runtime-summary.example.test",
    agent_service_id: "runtime-summary.example.test",
    agent_service_dir: $service_dir,
    agent_credentials_file: $credentials,
    mcp_credentials_file: $credentials,
    mcp_command: "direxio-mcp",
    agent_token: "AGENT_TOKEN_RUNTIME",
    agent_room_id: "!agent:runtime-summary.example.test",
    cc_connect_config: $config,
    cc_connect_binary: "direxio-connect",
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

verify_output=$(P2P_WORKDIR="$service_dir" PATH="$fakebin:$PATH" EXPECTED_CREDENTIALS_FILE="$credentials" CONNECT_WORK_DIR="$service_dir/cc-connect" bash "$ROOT/scripts/orchestrate.sh" verify runtime)
printf '%s\n' "$verify_output" | grep -q 'verified runtime checks: passed'

jq -e '
  .runtime_checks.summary.status == "passed"
  and .runtime_checks.summary.failed_count == 0
  and .runtime_checks.summary.checks.connect_daemon == "passed"
  and .runtime_checks.summary.checks.mcp_doctor == "passed"
  and .runtime_checks.summary.checks.mcp_tools == "passed"
  and .runtime_checks.summary.checks.mcp_smoke == "passed"
  and (.user_confirmations.agent_mcp_runtime | not)
' "$state" >/dev/null

report_output=$(P2P_WORKDIR="$service_dir" bash "$ROOT/scripts/orchestrate.sh" report new_deploy)
report_path=$(printf '%s\n' "$report_output" | sed -nE 's/^operation report: //p' | tail -n 1)
jq -e '.runtime_checks.summary.status == "passed"' "$report_path" >/dev/null

set +e
P2P_WORKDIR="$service_dir" PATH="$fakebin:$PATH" EXPECTED_CREDENTIALS_FILE="$credentials" CONNECT_WORK_DIR="$HOME/.direxio/nodes/other.example.test/cc-connect" bash "$ROOT/scripts/orchestrate.sh" verify runtime > "$tmp/runtime-fail.out" 2>&1
fail_rc=$?
set -e
[ "$fail_rc" -ne 0 ] || {
  echo "runtime summary must fail when any runtime check fails" >&2
  exit 1
}
jq -e '
  .runtime_checks.summary.status == "failed"
  and .runtime_checks.summary.failed_count == 1
  and .runtime_checks.summary.checks.connect_daemon == "failed"
  and .runtime_checks.summary.checks.mcp_doctor == "passed"
  and .runtime_checks.summary.checks.mcp_tools == "passed"
  and .runtime_checks.summary.checks.mcp_smoke == "passed"
' "$state" >/dev/null

echo "runtime summary check ok"
