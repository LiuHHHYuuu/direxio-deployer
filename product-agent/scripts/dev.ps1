param(
  [string]$EnvFile = ".env.local",
  [string]$GatewayHost = "127.0.0.1",
  [int]$GatewayPort = 8787,
  [string]$AgentHost = "127.0.0.1",
  [int]$AgentPort = 8797,
  [ValidateSet("auto", "echo", "openai-compatible")]
  [string]$ModelMode = "auto",
  [switch]$DebugProvider,
  [switch]$Restart,
  [switch]$RunModelCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProductAgentDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $env:TEMP "direxio-product-agent-dev"

function Import-LocalEnv {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "No env file found at $Path; using safe local defaults."
    return
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $equals = $trimmed.IndexOf("=")
    if ($equals -le 0) { continue }
    $name = $trimmed.Substring(0, $equals).Trim()
    $value = $trimmed.Substring($equals + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:$name" -Value $value
  }
}

function Get-ListeningPid {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($connection) { return [int]$connection.OwningProcess }
  return $null
}

function Get-CommandLine {
  param([int]$ProcessId)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($process) { return [string]$process.CommandLine }
  return ""
}

function Test-ProductAgentProcess {
  param([int]$ProcessId)
  $commandLine = Get-CommandLine -ProcessId $ProcessId
  return $commandLine -like "*product-agent*" -and ($commandLine -like "*agent-service.ts*" -or $commandLine -like "*ai-gateway.ts*")
}

function Stop-ProductAgentPort {
  param([int]$Port)
  $listenerPid = Get-ListeningPid -Port $Port
  if (-not $listenerPid) { return }
  if (-not (Test-ProductAgentProcess -ProcessId $listenerPid)) {
    throw "Port $Port is occupied by a non-product-agent process (pid $listenerPid). Stop it manually or choose another port."
  }
  Stop-Process -Id $listenerPid -Force
  Start-Sleep -Milliseconds 500
}

function Ensure-PortAvailable {
  param([int]$Port, [string]$Name)
  $listenerPid = Get-ListeningPid -Port $Port
  if (-not $listenerPid) { return }
  if (-not (Test-ProductAgentProcess -ProcessId $listenerPid)) {
    throw "$Name port $Port is occupied by a non-product-agent process (pid $listenerPid)."
  }
  if ($Restart) {
    Stop-ProductAgentPort -Port $Port
    return
  }
  throw "$Name is already running on port $Port (pid $listenerPid). Re-run with -Restart to replace it."
}

function Wait-Listening {
  param([int]$Port, [string]$Name)
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $listenerPid = Get-ListeningPid -Port $Port
    if ($listenerPid) { return $listenerPid }
    Start-Sleep -Milliseconds 250
  }
  throw "$Name did not start listening on port $Port within 30 seconds."
}

function Start-NpmRole {
  param([string]$Name, [string]$NpmScript, [string]$OutLog, [string]$ErrLog)
  $command = "npm run $NpmScript"
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -WorkingDirectory $ProductAgentDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru | Out-Null
  Write-Host "Starting $Name..."
}

function Invoke-NoCostHealthCheck {
  $body = @{
    node_id = "local-dev-node"
    conversation_id = "health-room"
    conversation_type = "human_dm"
    sender_kind = "user"
    content = "health check"
  } | ConvertTo-Json -Depth 8
  $response = Invoke-RestMethod -Method Post -Uri "http://${AgentHost}:$AgentPort/v1/message-server/new-message" -ContentType "application/json" -Body $body -TimeoutSec 15
  if ($response.ignored -ne $true) {
    throw "No-cost health check failed: expected ignored=true."
  }
}

function Invoke-ModelHealthCheck {
  $body = @{
    node_id = "local-dev-node"
    conversation_id = "health-room"
    conversation_type = "direxio_ai"
    sender_kind = "user"
    content = "Reply with exactly: DIREXIO_AGENT_OK"
  } | ConvertTo-Json -Depth 8
  $response = Invoke-RestMethod -Method Post -Uri "http://${AgentHost}:$AgentPort/v1/message-server/new-message" -ContentType "application/json" -Body $body -TimeoutSec 90
  Write-Host "Model check reply: $($response.reply)"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Import-LocalEnv -Path (Join-Path $ProductAgentDir $EnvFile)

if (-not $env:DIREXIO_AI_GATEWAY_TOKENS) { $env:DIREXIO_AI_GATEWAY_TOKENS = "dxai_test" }
if (-not $env:DIREXIO_AI_TOKEN) { $env:DIREXIO_AI_TOKEN = (($env:DIREXIO_AI_GATEWAY_TOKENS -split ",")[0]).Trim() }

$env:DIREXIO_AI_GATEWAY_HOST = $GatewayHost
$env:DIREXIO_AI_GATEWAY_PORT = [string]$GatewayPort
$env:DIREXIO_AGENT_SERVICE_HOST = $AgentHost
$env:DIREXIO_AGENT_SERVICE_PORT = [string]$AgentPort
$env:DIREXIO_AI_GATEWAY_URL = "http://${GatewayHost}:$GatewayPort"

if ($ModelMode -eq "auto") {
  $ModelMode = if ($env:DIREXIO_MODEL_API_KEY) { "openai-compatible" } else { "echo" }
}
$env:DIREXIO_AI_GATEWAY_MODEL_MODE = $ModelMode

if ($ModelMode -eq "openai-compatible") {
  if (-not $env:DIREXIO_MODEL_API_KEY) {
    throw "DIREXIO_MODEL_API_KEY is required for openai-compatible mode. Put it in .env.local."
  }
  if ($env:DIREXIO_MODEL_API_KEY.StartsWith("<") -or $env:DIREXIO_MODEL_API_KEY.EndsWith(">")) {
    throw "DIREXIO_MODEL_API_KEY should be the raw key only. Remove angle brackets."
  }
  if (-not $env:DIREXIO_MODEL_BASE_URL) { $env:DIREXIO_MODEL_BASE_URL = "https://api.deepseek.com" }
  if ($env:DIREXIO_MODEL_BASE_URL -match "api\.deepseek\.com/v1/?$") {
    throw "For DeepSeek, use DIREXIO_MODEL_BASE_URL=https://api.deepseek.com without /v1."
  }
  if (-not $env:DIREXIO_MODEL_NAME) { $env:DIREXIO_MODEL_NAME = "deepseek-v4-flash" }
}

if ($DebugProvider) {
  $env:DIREXIO_AI_GATEWAY_DEBUG_PROVIDER = "1"
} else {
  Remove-Item Env:DIREXIO_AI_GATEWAY_DEBUG_PROVIDER -ErrorAction SilentlyContinue
}

Ensure-PortAvailable -Port $GatewayPort -Name "ai-gateway"
Ensure-PortAvailable -Port $AgentPort -Name "agent-service"

$GatewayOut = Join-Path $LogDir "ai-gateway.$GatewayPort.out.log"
$GatewayErr = Join-Path $LogDir "ai-gateway.$GatewayPort.err.log"
$AgentOut = Join-Path $LogDir "agent-service.$AgentPort.out.log"
$AgentErr = Join-Path $LogDir "agent-service.$AgentPort.err.log"
Remove-Item -LiteralPath $GatewayOut, $GatewayErr, $AgentOut, $AgentErr -ErrorAction SilentlyContinue

Start-NpmRole -Name "ai-gateway" -NpmScript "dev:ai-gateway" -OutLog $GatewayOut -ErrLog $GatewayErr
$GatewayPid = Wait-Listening -Port $GatewayPort -Name "ai-gateway"

Start-NpmRole -Name "agent-service" -NpmScript "dev:agent-service" -OutLog $AgentOut -ErrLog $AgentErr
$AgentPid = Wait-Listening -Port $AgentPort -Name "agent-service"

Invoke-NoCostHealthCheck
if ($RunModelCheck) {
  Invoke-ModelHealthCheck
}

Write-Host "Product agent local dev is running."
Write-Host "  ai-gateway:    http://${GatewayHost}:$GatewayPort (pid $GatewayPid, mode $ModelMode)"
Write-Host "  agent-service: http://${AgentHost}:$AgentPort (pid $AgentPid)"
Write-Host "  logs:          $LogDir"
Write-Host "Stop with:       powershell -ExecutionPolicy Bypass -File scripts/stop-dev.ps1"
