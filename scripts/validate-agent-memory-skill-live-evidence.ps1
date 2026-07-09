param(
  [string] $LiveAppEvidencePath = 'docs\superpowers\plans\evidence\live-app-agent-memory-skill-evidence.md',
  [string] $SummaryJsonPath,
  [string] $AuditScriptPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
if ([string]::IsNullOrWhiteSpace($AuditScriptPath)) {
  $AuditScriptPath = Join-Path $ScriptDir 'audit-agent-memory-skill-goal.ps1'
}

function Resolve-InputPath {
  <#
    Function: Resolves an operator-supplied path relative to the repo root when it is not already absolute.
    Inputs:
      Path: Relative or absolute path supplied on the command line.
    Output:
      Absolute normalized filesystem path.
    Side effects:
      None.
    Errors:
      Throws when Path is empty.
  #>
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'Path cannot be empty.'
  }

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Path))
}

function Assert-FileExists {
  <#
    Function: Confirms that a required local file exists before running validation.
    Inputs:
      Path: Absolute file path.
      Label: Human-readable file label for errors.
    Output:
      None.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when the file is missing.
  #>
  param(
    [string] $Path,
    [string] $Label
  )

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "$Label was not found at $Path."
  }
}

function New-TempSummaryPath {
  <#
    Function: Creates a temporary JSON path for audit output when the operator did not request a persistent summary.
    Inputs:
      None.
    Output:
      Absolute JSON path in the OS temp directory.
    Side effects:
      None; the file is created by the audit script later.
    Errors:
      None.
  #>
  $name = 'direxio-live-evidence-validation-' + [guid]::NewGuid().ToString('N') + '.json'
  return Join-Path ([System.IO.Path]::GetTempPath()) $name
}

function Invoke-LiveEvidenceAudit {
  <#
    Function: Runs the completion audit with only live App gates enabled.
    Inputs:
      EvidencePath: Filled live App evidence markdown path.
      SummaryPath: JSON path where the audit should write machine-readable results.
    Output:
      Parsed audit summary object.
    Side effects:
      Executes a local PowerShell child process and writes one JSON summary.
    Errors:
      Throws when the audit process fails or the summary JSON cannot be read.
  #>
  param(
    [string] $EvidencePath,
    [string] $SummaryPath
  )

  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $AuditScriptPath,
    '-SkipLocalVerifier',
    '-SkipRemoteReadiness',
    '-LiveAppPromptSkillVerified',
    '-LiveAppMemoryVerified',
    '-LiveAppCardRenderingVerified',
    '-LiveAppEvidencePath',
    $EvidencePath,
    '-ReportOnly',
    '-SummaryJsonPath',
    $SummaryPath
  )

  $processOutput = & powershell @arguments
  $exitCode = $LASTEXITCODE
  $processOutput | ForEach-Object { Write-Host $_ }
  if ($exitCode -ne 0) {
    throw "Live evidence audit child process failed with exit code $exitCode."
  }

  if (-not (Test-Path $SummaryPath -PathType Leaf)) {
    throw "Live evidence audit did not write summary JSON at $SummaryPath."
  }

  return Get-Content -Raw $SummaryPath | ConvertFrom-Json
}

function Get-GateStatus {
  <#
    Function: Looks up one gate status from the parsed audit summary.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Exact gate name.
    Output:
      Status string for the requested gate.
    Side effects:
      None.
    Errors:
      Throws when the gate is missing or duplicated.
  #>
  param(
    [object] $Summary,
    [string] $Gate
  )

  $matches = @($Summary.gates | Where-Object { $_.Gate -eq $Gate })
  if ($matches.Count -ne 1) {
    throw "Expected exactly one '$Gate' gate, found $($matches.Count)."
  }
  return $matches[0].Status
}

function Write-FailedEvidenceDetails {
  <#
    Function: Prints missing live App evidence fields from the audit summary.
    Inputs:
      Summary: Parsed audit summary object.
    Output:
      None.
    Side effects:
      Writes diagnostic text to stdout.
    Errors:
      None.
  #>
  param([object] $Summary)

  $checks = @($Summary.live_app_evidence_checks | Where-Object { -not $_.passed })
  if ($checks.Count -eq 0) {
    return
  }

  Write-Host ""
  Write-Host "Missing or invalid evidence fields:"
  foreach ($check in $checks) {
    Write-Host "- $($check.required_heading): $(@($check.missing_fields) -join ', ')"
  }
}

function Assert-LiveGatesPassed {
  <#
    Function: Ensures all three live App evidence gates passed in the audit summary.
    Inputs:
      Summary: Parsed audit summary object.
    Output:
      None.
    Side effects:
      Writes missing-field diagnostics when validation fails.
    Errors:
      Throws when evidence is missing or any live gate is not PASS.
  #>
  param([object] $Summary)

  if (-not [bool]$Summary.live_app_evidence_present) {
    Write-FailedEvidenceDetails -Summary $Summary
    throw 'Live App evidence did not satisfy the required schema.'
  }

  $requiredGates = @(
    'Live App Prompt Skill path',
    'Live App memory path',
    'Live App card rendering path'
  )

  $failed = [System.Collections.Generic.List[string]]::new()
  foreach ($gate in $requiredGates) {
    $status = Get-GateStatus -Summary $Summary -Gate $gate
    if ($status -ne 'PASS') {
      $failed.Add("${gate}=${status}") | Out-Null
    }
  }

  if ($failed.Count -gt 0) {
    Write-FailedEvidenceDetails -Summary $Summary
    throw "Live App evidence gates did not all pass: $($failed -join ', ')."
  }
}

$resolvedAuditScript = Resolve-InputPath -Path $AuditScriptPath
$resolvedEvidence = Resolve-InputPath -Path $LiveAppEvidencePath
$usingTempSummary = [string]::IsNullOrWhiteSpace($SummaryJsonPath)
if ($usingTempSummary) {
  $resolvedSummary = New-TempSummaryPath
} else {
  $resolvedSummary = Resolve-InputPath -Path $SummaryJsonPath
}

Assert-FileExists -Path $resolvedAuditScript -Label 'Audit script'
Assert-FileExists -Path $resolvedEvidence -Label 'Live App evidence file'

Write-Host "Agent memory + Prompt Skill live evidence validation"
Write-Host "Evidence: $resolvedEvidence"
Write-Host "Summary: $resolvedSummary"
Write-Host "Mode: live evidence only; local verifier and remote readiness are skipped."

try {
  $summary = Invoke-LiveEvidenceAudit -EvidencePath $resolvedEvidence -SummaryPath $resolvedSummary
  Assert-LiveGatesPassed -Summary $summary
  Write-Host ""
  Write-Host "Live App evidence validation passed."
} finally {
  if ($usingTempSummary -and (Test-Path $resolvedSummary -PathType Leaf)) {
    Remove-Item -LiteralPath $resolvedSummary -Force
  }
}
