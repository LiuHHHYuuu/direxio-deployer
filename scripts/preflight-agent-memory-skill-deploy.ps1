param(
  [string] $ProductAgentRepo,
  [string] $MessageServerRepo,
  [string] $FlutterRepo,
  [string] $NodeDomain = 'codex1.p2pagent.im',
  [string] $SshUser = 'ubuntu',
  [string] $KeyFile,
  [string] $RemoteDir = '/var/direxio-message-server',
  [string] $GoPath,
  [string] $SummaryJsonPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

function Assert-ScriptExists {
  <#
    Function: Verifies that a required helper script exists before preflight starts.
    Inputs:
      Path: Absolute or relative helper script path.
    Output:
      None.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when the helper script is missing.
  #>
  param([string] $Path)

  if (-not (Test-Path $Path)) {
    throw "Required script was not found at $Path."
  }
}

function Add-OptionalValueArg {
  <#
    Function: Appends a named PowerShell argument only when its value is present.
    Inputs:
      CurrentArgs: Current argument array.
      Name: Argument name, including the leading dash.
      Value: Optional string value to pass to a child script.
    Output:
      Updated argument array.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string[]] $CurrentArgs,
    [string] $Name,
    [string] $Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $CurrentArgs
  }
  return $CurrentArgs + @($Name, $Value)
}

function New-DefaultSummaryJsonPath {
  <#
    Function: Builds the default machine-readable preflight audit evidence path.
    Inputs:
      None.
    Output:
      Relative path under docs/superpowers/plans/evidence.
    Side effects:
      Reads the current local clock for a timestamp.
    Errors:
      None.
  #>
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  return Join-Path $RepoRoot "docs\superpowers\plans\evidence\$stamp-agent-memory-skill-preflight-audit.json"
}

function Invoke-RequiredChildScript {
  <#
    Function: Runs one required child script and fails the preflight on non-zero exit.
    Inputs:
      Label: Human-readable step label.
      ScriptPath: Child PowerShell script path.
      Arguments: Argument array passed to the child script.
    Output:
      Child script output is streamed to the terminal.
    Side effects:
      Executes local checks, read-only remote inspection, or deploy dry-run depending on the child script.
    Errors:
      Throws when the child script exits with a non-zero code.
  #>
  param(
    [string] $Label,
    [string] $ScriptPath,
    [string[]] $Arguments
  )

  Write-Host ""
  Write-Host "==> $Label"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Read-AuditSummary {
  <#
    Function: Reads and validates the JSON summary produced by the completion audit.
    Inputs:
      Path: Summary JSON path expected to exist after the audit child script.
    Output:
      Parsed audit summary object.
    Side effects:
      Reads one local JSON file.
    Errors:
      Throws when the file is missing, malformed, or not the expected schema.
  #>
  param([string] $Path)

  if (-not (Test-Path $Path)) {
    throw "Audit summary JSON was not written at $Path."
  }

  $summary = Get-Content -Raw $Path | ConvertFrom-Json
  if ($summary.schema -ne 'direxio.agent_memory_prompt_skill_audit.v1') {
    throw "Unexpected audit summary schema: $($summary.schema)."
  }
  if ($summary.audit_finished -ne $true) {
    throw "Audit summary was written before the audit finished."
  }
  return $summary
}

function Get-GateStatus {
  <#
    Function: Finds one named completion gate status in the parsed audit summary.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Gate name to locate.
    Output:
      Status string for the requested gate.
    Side effects:
      None.
    Errors:
      Throws when the gate row is missing.
  #>
  param(
    [object] $Summary,
    [string] $Gate
  )

  $row = @($Summary.gates | Where-Object { $_.Gate -eq $Gate }) | Select-Object -First 1
  if (-not $row) {
    throw "Audit summary did not contain gate '$Gate'."
  }
  return [string]$row.Status
}

function Assert-GatePassed {
  <#
    Function: Requires one audit gate to be PASS before deployment approval can be requested.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Gate name to require.
    Output:
      None.
    Side effects:
      None.
    Errors:
      Throws when the gate is not PASS.
  #>
  param(
    [object] $Summary,
    [string] $Gate
  )

  $status = Get-GateStatus -Summary $Summary -Gate $Gate
  if ($status -ne 'PASS') {
    throw "Preflight requires '$Gate' to be PASS, but it was $status."
  }
}

$auditScript = Join-Path $ScriptDir 'audit-agent-memory-skill-goal.ps1'
$deployDryRunScript = Join-Path $ScriptDir 'deploy-agent-memory-skill-stack.ps1'
Assert-ScriptExists -Path $auditScript
Assert-ScriptExists -Path $deployDryRunScript

if ([string]::IsNullOrWhiteSpace($SummaryJsonPath)) {
  $SummaryJsonPath = New-DefaultSummaryJsonPath
}
$SummaryJsonPath = [System.IO.Path]::GetFullPath($SummaryJsonPath)

Write-Host "Agent memory + Prompt Skill deployment preflight"
Write-Host "Node: $SshUser@$NodeDomain"
Write-Host "Remote compose dir: $RemoteDir"
Write-Host "Mode: preflight only; no deploy, upload, .env edit, compose up, or restart."
Write-Host "Audit JSON: $SummaryJsonPath"

$auditArgs = @(
  '-NodeDomain', $NodeDomain,
  '-SshUser', $SshUser,
  '-RemoteDir', $RemoteDir,
  '-ReportOnly',
  '-SummaryJsonPath', $SummaryJsonPath
)
$auditArgs = Add-OptionalValueArg -CurrentArgs $auditArgs -Name '-ProductAgentRepo' -Value $ProductAgentRepo
$auditArgs = Add-OptionalValueArg -CurrentArgs $auditArgs -Name '-MessageServerRepo' -Value $MessageServerRepo
$auditArgs = Add-OptionalValueArg -CurrentArgs $auditArgs -Name '-FlutterRepo' -Value $FlutterRepo
$auditArgs = Add-OptionalValueArg -CurrentArgs $auditArgs -Name '-GoPath' -Value $GoPath
$auditArgs = Add-OptionalValueArg -CurrentArgs $auditArgs -Name '-KeyFile' -Value $KeyFile

Invoke-RequiredChildScript `
  -Label 'completion audit in ReportOnly mode' `
  -ScriptPath $auditScript `
  -Arguments $auditArgs

$summary = Read-AuditSummary -Path $SummaryJsonPath
Assert-GatePassed -Summary $summary -Gate 'Local verifier'

$remoteStatus = Get-GateStatus -Summary $summary -Gate 'Remote readiness'
$promptSkillStatus = Get-GateStatus -Summary $summary -Gate 'Live App Prompt Skill path'
$memoryStatus = Get-GateStatus -Summary $summary -Gate 'Live App memory path'
$cardStatus = Get-GateStatus -Summary $summary -Gate 'Live App card rendering path'

Write-Host ""
Write-Host "==> audit gate interpretation"
Write-Host "Local verifier: PASS"
Write-Host "Remote readiness: $remoteStatus"
Write-Host "Live App Prompt Skill path: $promptSkillStatus"
Write-Host "Live App memory path: $memoryStatus"
Write-Host "Live App card rendering path: $cardStatus"
Write-Host "Remote readiness and live App gates are allowed to be incomplete before approved deployment."

$dryRunArgs = @(
  '-NodeDomain', $NodeDomain,
  '-SshUser', $SshUser,
  '-RemoteDir', $RemoteDir
)
$dryRunArgs = Add-OptionalValueArg -CurrentArgs $dryRunArgs -Name '-ProductAgentRepo' -Value $ProductAgentRepo
$dryRunArgs = Add-OptionalValueArg -CurrentArgs $dryRunArgs -Name '-MessageServerRepo' -Value $MessageServerRepo
$dryRunArgs = Add-OptionalValueArg -CurrentArgs $dryRunArgs -Name '-FlutterRepo' -Value $FlutterRepo
$dryRunArgs = Add-OptionalValueArg -CurrentArgs $dryRunArgs -Name '-GoPath' -Value $GoPath
$dryRunArgs = Add-OptionalValueArg -CurrentArgs $dryRunArgs -Name '-KeyFile' -Value $KeyFile

Invoke-RequiredChildScript `
  -Label 'full-stack deploy dry-run' `
  -ScriptPath $deployDryRunScript `
  -Arguments $dryRunArgs

Write-Host ""
Write-Host "Preflight passed."
Write-Host "This proves local correctness and deploy guardrails, but it does not complete the goal."
Write-Host "Next human-controlled step:"
Write-Host "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-agent-memory-skill-stack.ps1 -NodeDomain $NodeDomain -Apply -IUnderstandThisRestartsProductAgent -IUnderstandThisRestartsMessageServer"
