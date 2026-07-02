param(
  [string[]]$Ports = @("8787", "8797")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

foreach ($portText in $Ports) {
  foreach ($portValue in ($portText -split ",")) {
    $portValue = $portValue.Trim()
    if (-not $portValue) { continue }
    $port = [int]$portValue
    $listenerPid = Get-ListeningPid -Port $port
    if (-not $listenerPid) {
      Write-Host "Port $port is not listening."
      continue
    }
    if (-not (Test-ProductAgentProcess -ProcessId $listenerPid)) {
      Write-Host "Port $port is owned by a non-product-agent process (pid $listenerPid); skipping."
      continue
    }
    Stop-Process -Id $listenerPid -Force
    Write-Host "Stopped product-agent process on port $port (pid $listenerPid)."
  }
}
