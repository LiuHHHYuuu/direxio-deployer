param(
  [string] $NodeDomain = 'codex1.p2pagent.im',
  [string] $SshUser = 'ubuntu',
  [string] $KeyFile,
  [string] $RemoteDir = '/var/direxio-message-server',
  [switch] $RequireConfigOnlySmoke,
  [switch] $RequireLatestMessageServerBridge
)

$ErrorActionPreference = 'Stop'

function Resolve-NodeKeyFile {
  <#
    Function: Finds the SSH private key for the target Direxio node.
    Inputs:
      Candidate: Optional explicit PEM path.
      Domain: Node domain, used to inspect ~/.direxio/nodes/<domain>.
    Output:
      Absolute PEM path.
    Side effects:
      Reads local node state files only.
    Errors:
      Throws when no PEM can be found.
  #>
  param(
    [string] $Candidate,
    [string] $Domain
  )

  if ($Candidate) {
    $resolved = [System.IO.Path]::GetFullPath($Candidate)
    if (Test-Path $resolved) { return $resolved }
    throw "SSH key was not found at $resolved."
  }

  $nodeDir = Join-Path $env:USERPROFILE ".direxio\nodes\$Domain"
  if (-not (Test-Path $nodeDir)) {
    throw "Node state was not found at $nodeDir. Pass -KeyFile <path>."
  }

  $pem = Get-ChildItem $nodeDir -Filter '*.pem' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $pem) {
    throw "No PEM file was found under $nodeDir. Pass -KeyFile <path>."
  }

  return $pem.FullName
}

function Assert-CommandAvailable {
  <#
    Function: Verifies that a required local command is available.
    Inputs:
      Name: Command name to resolve from PATH.
    Output:
      None.
    Side effects:
      Reads PATH through Get-Command.
    Errors:
      Throws when the command is unavailable.
  #>
  param([string] $Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Shell-SingleQuote {
  <#
    Function: Quotes a value for safe inclusion in the generated remote shell script.
    Inputs:
      Value: String value to quote.
    Output:
      Single-quoted shell literal.
    Side effects:
      None.
    Errors:
      None.
  #>
  param([string] $Value)

  return "'" + ($Value -replace "'", "'\''") + "'"
}

function New-RemoteInspectScript {
  <#
    Function: Creates the read-only remote inspection script.
    Inputs:
      RemoteDirPath: Docker compose directory on the node.
      RequireConfigOnlySmokeFlag: Whether missing config-only smoke support should fail the inspection.
      RequireLatestMessageServerBridgeFlag: Whether missing latest message-server bridge markers should fail the inspection.
    Output:
      Shell script text.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string] $RemoteDirPath,
    [bool] $RequireConfigOnlySmokeFlag,
    [bool] $RequireLatestMessageServerBridgeFlag
  )

  $quotedRemoteDir = Shell-SingleQuote $RemoteDirPath
  $requireConfigOnlySmoke = if ($RequireConfigOnlySmokeFlag) { '1' } else { '0' }
  $requireLatestMessageServerBridge = if ($RequireLatestMessageServerBridgeFlag) { '1' } else { '0' }
  return @"
#!/usr/bin/env bash
set -euo pipefail

REMOTE_DIR=$quotedRemoteDir
REQUIRE_CONFIG_ONLY_SMOKE=$requireConfigOnlySmoke
REQUIRE_LATEST_MESSAGE_SERVER_BRIDGE=$requireLatestMessageServerBridge
readiness_failed=0
cd "`$REMOTE_DIR"

echo "== Direxio Agent Stack Readiness =="
echo "remote_dir=`$REMOTE_DIR"
echo "host=`$(hostname)"
echo "time_utc=`$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ ! -f docker-compose.yml ]; then
  echo "missing docker-compose.yml in `$REMOTE_DIR" >&2
  exit 1
fi

compose() {
  sudo docker compose --env-file .env "`$@"
}

echo
echo "== .env agent keys =="
if sudo test -f .env; then
  sudo grep -E '^(COMPOSE_PROFILES|DIREXIO_PRODUCT_AGENT_IMAGE|DIREXIO_PRODUCT_AGENT_URL|DIREXIO_AGENT_RUNTIME|DIREXIO_AGENT_WEB_SEARCH|DIREXIO_AGENT_DATA_DIR|DIREXIO_AI_GATEWAY_URL|DIREXIO_AI_TOKEN)=' .env |
    sed -E 's/^(.*TOKEN=).*/\1<redacted>/' || true
else
  echo ".env missing"
fi

echo
echo "== compose ps =="
compose ps message-server product-agent || true

echo
echo "== container images =="
for service in message-server product-agent; do
  cid="`$(compose ps -q "`$service" 2>/dev/null || true)"
  if [ -z "`$cid" ]; then
    echo "`$service: not running"
    continue
  fi
  image="`$(sudo docker inspect --format '{{.Config.Image}}' "`$cid" 2>/dev/null || true)"
  created="`$(sudo docker inspect --format '{{.Created}}' "`$cid" 2>/dev/null || true)"
  echo "`$service image=`$image created=`$created"
done

echo
echo "== message-server health =="
if cid="`$(compose ps -q message-server 2>/dev/null)" && [ -n "`$cid" ]; then
  compose exec -T message-server sh -lc 'wget -q -O- http://127.0.0.1:8008/_p2p/health' < /dev/null || true
else
  echo "message-server not running"
fi

echo
echo "== message-server bridge readiness =="
if cid="`$(compose ps -q message-server 2>/dev/null)" && [ -n "`$cid" ]; then
  product_agent_message_bridge="`$(compose exec -T message-server sh -lc "if grep -a -q '/v1/message-server/new-message' /usr/bin/direxio-message-server 2>/dev/null; then echo present; else echo missing; fi" < /dev/null || true)"
  agent_card_bridge="`$(compose exec -T message-server sh -lc "if grep -a -q 'io.direxio.agent_action_result' /usr/bin/direxio-message-server 2>/dev/null; then echo present; else echo missing; fi" < /dev/null || true)"
  agent_memory_plugin_bridge="`$(compose exec -T message-server sh -lc "if grep -a -q 'agent.memory.save' /usr/bin/direxio-message-server 2>/dev/null; then echo present; else echo missing; fi" < /dev/null || true)"
  product_agent_url_env="`$(compose exec -T message-server sh -lc "if env | grep -q '^DIREXIO_PRODUCT_AGENT_URL=.'; then echo present; else echo missing; fi" < /dev/null || true)"
  echo "product-agent-message-bridge=`$product_agent_message_bridge"
  echo "agent-card-bridge=`$agent_card_bridge"
  echo "agent-memory-plugin-bridge=`$agent_memory_plugin_bridge"
  echo "product-agent-url-env=`$product_agent_url_env"
  if [ "`$REQUIRE_LATEST_MESSAGE_SERVER_BRIDGE" = "1" ]; then
    if [ "`$product_agent_message_bridge" != "present" ] || [ "`$agent_card_bridge" != "present" ] || [ "`$agent_memory_plugin_bridge" != "present" ] || [ "`$product_agent_url_env" != "present" ]; then
      echo "latest message-server product-agent bridge support is required but missing" >&2
      readiness_failed=1
    fi
  fi
else
  echo "message-server not running"
  if [ "`$REQUIRE_LATEST_MESSAGE_SERVER_BRIDGE" = "1" ]; then
    readiness_failed=1
  fi
fi

echo
echo "== product-agent readiness =="
if cid="`$(compose ps -q product-agent 2>/dev/null)" && [ -n "`$cid" ]; then
  compose exec -T product-agent sh -lc 'printf "agent-runtime=%s\n" "`$`{DIREXIO_AGENT_RUNTIME:-langchain`}"' < /dev/null || true
  compose exec -T product-agent sh -lc 'printf "web-search=%s\n" "`$`{DIREXIO_AGENT_WEB_SEARCH:-1`}"' < /dev/null || true
  compose exec -T product-agent sh -lc 'test -f dist/bin/remote-smoke-runner.js && echo remote-smoke-runner=present || echo remote-smoke-runner=missing' < /dev/null || true
  config_only_smoke="`$(compose exec -T product-agent sh -lc "if grep -q 'agent-config-only-smoke' dist/bin/remote-smoke-runner.js 2>/dev/null; then echo present; else echo missing; fi" < /dev/null || true)"
  echo "config-only-smoke=`$config_only_smoke"
  if [ "`$REQUIRE_CONFIG_ONLY_SMOKE" = "1" ] && [ "`$config_only_smoke" != "present" ]; then
    echo "config-only smoke support is required but missing" >&2
    readiness_failed=1
  fi
  compose exec -T product-agent node -e "fetch('http://127.0.0.1:8797/v1/agent/actions').then(async r=>{console.log('actions_status='+r.status); const j=await r.json(); console.log('actions_schema='+(j.schema||''));}).catch(e=>{console.log('actions_error='+e.message); process.exitCode=1;})" < /dev/null || true
  compose exec -T product-agent node -e "fetch('http://127.0.0.1:8797/v1/agent/tools').then(async r=>{const j=await r.json(); const items=Array.isArray(j.items)?j.items:[]; console.log('tools_status='+r.status); console.log('tools_count='+items.length); console.log('has_memory_save='+items.some(t=>t.name==='memory_save')); console.log('has_prompt_tools='+items.some(t=>String(t.name||'').startsWith('prompt_skill_')));}).catch(e=>{console.log('tools_error='+e.message); process.exitCode=1;})" < /dev/null || true
else
  echo "product-agent not running"
  if [ "`$REQUIRE_CONFIG_ONLY_SMOKE" = "1" ]; then
    readiness_failed=1
  fi
fi

echo
echo "Read-only inspection complete."
if [ "`$readiness_failed" = "1" ]; then
  echo "one or more required readiness gates failed" >&2
  exit 1
fi
"@
}

$keyPath = Resolve-NodeKeyFile -Candidate $KeyFile -Domain $NodeDomain
$sshTarget = "$SshUser@$NodeDomain"

Assert-CommandAvailable -Name 'ssh'

Write-Host "Node: $sshTarget"
Write-Host "Remote compose dir: $RemoteDir"
Write-Host "SSH key: $keyPath"
Write-Host "Mode: read-only inspection; no deploy, upload, .env edit, compose up, or restart."
if ($RequireConfigOnlySmoke) {
  Write-Host "Require: config-only Prompt Skill smoke must be present."
}
if ($RequireLatestMessageServerBridge) {
  Write-Host "Require: latest message-server product-agent bridge markers must be present."
}
Write-Host ""

$remoteScript = New-RemoteInspectScript `
  -RemoteDirPath $RemoteDir `
  -RequireConfigOnlySmokeFlag ([bool]$RequireConfigOnlySmoke) `
  -RequireLatestMessageServerBridgeFlag ([bool]$RequireLatestMessageServerBridge)
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = "printf '%s' '$encoded' | base64 -d | bash"

& ssh -i $keyPath -o StrictHostKeyChecking=accept-new $sshTarget $remoteCommand
if ($LASTEXITCODE -ne 0) {
  throw "remote read-only inspection failed with exit code $LASTEXITCODE."
}
