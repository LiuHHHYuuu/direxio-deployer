param(
  [string] $SummaryJsonPath,
  [string] $EvidenceDir = 'docs\superpowers\plans\evidence',
  [string] $NodeDomain = 'codex1.p2pagent.im'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

function Resolve-RepoPath {
  <#
    Function: Resolves a relative path from the repository root, or normalizes an absolute path.
    Inputs:
      Path: Relative or absolute filesystem path.
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

function Find-LatestAuditSummary {
  <#
    Function: Finds the newest local Agent memory + Prompt Skill audit JSON file.
    Inputs:
      Directory: Absolute evidence directory path.
    Output:
      Absolute JSON file path, or an empty string when no summary exists.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      None; missing directories return an empty string.
  #>
  param([string] $Directory)

  if (-not (Test-Path $Directory -PathType Container)) {
    return ''
  }

  $latest = Get-ChildItem -Path $Directory -Filter '*agent-memory-skill*audit.json' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $latest) {
    return ''
  }
  return $latest.FullName
}

function Read-AuditSummary {
  <#
    Function: Reads and validates one machine-readable Agent memory + Prompt Skill audit summary.
    Inputs:
      Path: Absolute JSON summary path.
    Output:
      Parsed audit summary object.
    Side effects:
      Reads one local JSON file.
    Errors:
      Throws when the file is missing, malformed, or not the expected audit schema.
  #>
  param([string] $Path)

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "Audit summary JSON was not found at $Path."
  }

  $summary = Get-Content -Raw $Path | ConvertFrom-Json
  if ($summary.schema -ne 'direxio.agent_memory_prompt_skill_audit.v1') {
    throw "Unexpected audit summary schema: $($summary.schema)."
  }
  return $summary
}

function Get-GateRow {
  <#
    Function: Finds one named gate row in a parsed audit summary.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Exact gate name.
    Output:
      Gate row object, or null when missing.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [object] $Summary,
    [string] $Gate
  )

  return @($Summary.gates | Where-Object { $_.Gate -eq $Gate } | Select-Object -First 1)
}

function Get-GateStatus {
  <#
    Function: Reads one named gate status from a parsed audit summary.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Exact gate name.
    Output:
      Status string, or MISSING when the gate is absent.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [object] $Summary,
    [string] $Gate
  )

  $row = Get-GateRow -Summary $Summary -Gate $Gate
  if (-not $row) {
    return 'MISSING'
  }
  return [string]$row.Status
}

function Write-GateStatus {
  <#
    Function: Prints one concise gate status row for the operator.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Exact gate name.
    Output:
      None.
    Side effects:
      Writes a human-readable line to stdout.
    Errors:
      None.
  #>
  param(
    [object] $Summary,
    [string] $Gate
  )

  $status = Get-GateStatus -Summary $Summary -Gate $Gate
  Write-Host ("- {0}: {1}" -f $Gate, $status)
}

function Write-RecommendedNextSteps {
  <#
    Function: Prints the next safest operator action based on current gate statuses.
    Inputs:
      Summary: Parsed audit summary object.
      NodeDomain: Node domain used in generated commands.
    Output:
      None.
    Side effects:
      Writes human-readable recommendations and commands to stdout.
    Errors:
      None.
  #>
  param(
    [object] $Summary,
    [string] $NodeDomain
  )

  $local = Get-GateStatus -Summary $Summary -Gate 'Local verifier'
  $remote = Get-GateStatus -Summary $Summary -Gate 'Remote readiness'
  $prompt = Get-GateStatus -Summary $Summary -Gate 'Live App Prompt Skill path'
  $memory = Get-GateStatus -Summary $Summary -Gate 'Live App memory path'
  $card = Get-GateStatus -Summary $Summary -Gate 'Live App card rendering path'

  Write-Host ""
  Write-Host "Recommended next step:"
  if ([bool]$Summary.complete) {
    Write-Host "- Completion is already proven by this audit summary."
    return
  }

  if ($local -ne 'PASS') {
    Write-Host "- Fix local implementation or tests, then rerun preflight:"
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight-agent-memory-skill-deploy.ps1 -NodeDomain $NodeDomain"
    return
  }

  if ($remote -ne 'PASS') {
    Write-Host "- Remote is not on the latest verified build. After explicit approval for both restarts, deploy with:"
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-agent-memory-skill-stack.ps1 -NodeDomain $NodeDomain -Apply -IUnderstandThisRestartsProductAgent -IUnderstandThisRestartsMessageServer"
    return
  }

  if (($prompt -ne 'PASS') -or ($memory -ne 'PASS') -or ($card -ne 'PASS')) {
    Write-Host "- Remote is ready; run live App verification and evidence validation:"
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-agent-memory-skill-live-evidence.ps1 -NodeDomain $NodeDomain"
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-agent-memory-skill-live-evidence.ps1 -LiveAppEvidencePath <evidence-path>"
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit-agent-memory-skill-goal.ps1 -NodeDomain $NodeDomain -LiveAppPromptSkillVerified -LiveAppMemoryVerified -LiveAppCardRenderingVerified -LiveAppEvidencePath <evidence-path> -SummaryJsonPath docs\superpowers\plans\evidence\postdeploy-agent-memory-skill-audit.json"
    return
  }

  Write-Host "- All named gates look PASS, but summary.complete is false. Rerun the final completion audit."
}

$resolvedEvidenceDir = Resolve-RepoPath -Path $EvidenceDir
if ([string]::IsNullOrWhiteSpace($SummaryJsonPath)) {
  $resolvedSummaryPath = Find-LatestAuditSummary -Directory $resolvedEvidenceDir
} else {
  $resolvedSummaryPath = Resolve-RepoPath -Path $SummaryJsonPath
}

Write-Host "Agent memory + Prompt Skill status"
Write-Host "Evidence dir: $resolvedEvidenceDir"
if ([string]::IsNullOrWhiteSpace($resolvedSummaryPath)) {
  Write-Host "No audit summary was found."
  Write-Host ""
  Write-Host "Recommended next step:"
  Write-Host "- Run preflight:"
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight-agent-memory-skill-deploy.ps1 -NodeDomain $NodeDomain"
  exit 0
}

$summary = Read-AuditSummary -Path $resolvedSummaryPath
Write-Host "Summary: $resolvedSummaryPath"
Write-Host "Generated UTC: $($summary.generated_at_utc)"
Write-Host "Complete: $($summary.complete)"
Write-Host "Blocking gates: $($summary.blocking_gate_count)"
Write-Host ""
Write-Host "Gate status:"
Write-GateStatus -Summary $summary -Gate 'Local verifier'
Write-GateStatus -Summary $summary -Gate 'Remote readiness'
Write-GateStatus -Summary $summary -Gate 'Live App Prompt Skill path'
Write-GateStatus -Summary $summary -Gate 'Live App memory path'
Write-GateStatus -Summary $summary -Gate 'Live App card rendering path'
Write-RecommendedNextSteps -Summary $summary -NodeDomain $NodeDomain
