param(
  [string] $ProductAgentRepo,
  [string] $MessageServerRepo,
  [string] $FlutterRepo,
  [string] $GoPath,
  [string] $NodeDomain = 'codex1.p2pagent.im',
  [string] $SshUser = 'ubuntu',
  [string] $KeyFile,
  [string] $RemoteDir = '/var/direxio-message-server',
  [switch] $SkipLocalVerifier,
  [switch] $SkipRemoteReadiness,
  [switch] $LiveAppPromptSkillVerified,
  [switch] $LiveAppMemoryVerified,
  [switch] $LiveAppCardRenderingVerified,
  [string] $LiveAppEvidencePath,
  [switch] $ReportOnly,
  [string] $SummaryJsonPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GateResults = [System.Collections.Generic.List[object]]::new()

function Assert-ScriptExists {
  <#
    Function: Verifies that a required local audit helper exists.
    Inputs:
      Path: Absolute or relative script path to check.
    Output:
      None.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when the script file is missing.
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

function Add-GateResult {
  <#
    Function: Records one completion gate result in the audit table.
    Inputs:
      Gate: Short gate name.
      Status: PASS, FAIL, PENDING, or SKIPPED.
      Evidence: Human-readable evidence or missing evidence.
    Output:
      None.
    Side effects:
      Appends to the process-local GateResults list.
    Errors:
      None.
  #>
  param(
    [string] $Gate,
    [string] $Status,
    [string] $Evidence
  )

  $GateResults.Add([pscustomobject]@{
      Gate     = $Gate
      Status   = $Status
      Evidence = $Evidence
    }) | Out-Null
}

function Invoke-GateScript {
  <#
    Function: Runs one external gate script and records pass/fail without stopping the audit.
    Inputs:
      Gate: Short gate name.
      ScriptPath: Child PowerShell script path.
      Arguments: Argument array passed to the child script.
      SuccessEvidence: Evidence text to record when the child exits successfully.
      FailureEvidence: Evidence text to record when the child exits non-zero.
    Output:
      None.
    Side effects:
      Executes a local child PowerShell process. The called scripts used here are local checks or read-only remote inspections.
    Errors:
      Records failures as FAIL rows instead of throwing, so later gates can still be reported.
  #>
  param(
    [string] $Gate,
    [string] $ScriptPath,
    [string[]] $Arguments,
    [string] $SuccessEvidence,
    [string] $FailureEvidence
  )

  Write-Host ""
  Write-Host "==> $Gate"
  $commandArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments
  & powershell @commandArgs
  if ($LASTEXITCODE -eq 0) {
    Add-GateResult -Gate $Gate -Status 'PASS' -Evidence $SuccessEvidence
  } else {
    Add-GateResult -Gate $Gate -Status 'FAIL' -Evidence "$FailureEvidence Exit code: $LASTEXITCODE."
  }
}

function Add-ManualGate {
  <#
    Function: Records one manually verified live App gate.
    Inputs:
      Gate: Short gate name.
      IsVerified: Whether the operator supplied the matching verification flag.
      Evidence: Evidence text to record when verified.
      Missing: Missing-evidence text to record when not verified.
      EvidenceStatus: Parsed status for the durable live App evidence file.
    Output:
      None.
    Side effects:
      Appends to the process-local GateResults list.
    Errors:
      None.
  #>
  param(
    [string] $Gate,
    [bool] $IsVerified,
    [string] $Evidence,
    [string] $Missing,
    [object] $EvidenceStatus
  )

  if ($IsVerified) {
    if ($EvidenceStatus.Ready) {
      Add-GateResult -Gate $Gate -Status 'PASS' -Evidence "$Evidence $($EvidenceStatus.Evidence)"
    } else {
      Add-GateResult -Gate $Gate -Status 'FAIL' -Evidence "$Evidence Missing durable evidence: $($EvidenceStatus.Evidence)"
    }
  } else {
    Add-GateResult -Gate $Gate -Status 'PENDING' -Evidence $Missing
  }
}

function Get-LiveAppEvidenceSectionBody {
  <#
    Function: Extracts one markdown evidence section body.
    Inputs:
      Content: Full markdown evidence file content.
      Heading: Section heading without the leading markdown `##`.
    Output:
      Section body text, or an empty string when the section is missing.
    Side effects:
      None.
    Errors:
      None; malformed or missing sections return an empty string.
  #>
  param(
    [string] $Content,
    [string] $Heading
  )

  $escapedHeading = [regex]::Escape($Heading)
  $pattern = '(?ms)^##\s+' + $escapedHeading + '\s*\r?\n(?<body>.*?)(?=^##\s+|\z)'
  $sectionMatch = [regex]::Match($Content, $pattern)
  if (-not $sectionMatch.Success) {
    return ''
  }
  return $sectionMatch.Groups['body'].Value
}

function Test-LiveAppEvidenceResultPass {
  <#
    Function: Checks whether one evidence section has exactly one PASS result line.
    Inputs:
      Body: Markdown body for one evidence section.
    Output:
      True when the section contains exactly one `- Result: PASS` line.
    Side effects:
      None.
    Errors:
      None.
  #>
  param([string] $Body)

  $matches = [regex]::Matches($Body, '(?im)^\s*-\s*Result:\s*PASS\s*$')
  return $matches.Count -eq 1
}

function Test-LiveAppEvidenceFieldFilled {
  <#
    Function: Checks whether one required evidence field is filled with a meaningful value.
    Inputs:
      Body: Markdown body for one evidence section.
      Label: Required bullet label before the colon.
    Output:
      True when the label exists and its value is not empty, TODO, TBD, N/A, or the template placeholder.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string] $Body,
    [string] $Label
  )

  $escapedLabel = [regex]::Escape($Label)
  $match = [regex]::Match($Body, "(?im)^[ \t]*-[ \t]*$escapedLabel[ \t]*:[ \t]*(?<value>.*?)[ \t]*$")
  if (-not $match.Success) {
    return $false
  }
  $value = $match.Groups['value'].Value.Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $false
  }
  return -not ($value -match '^(TODO|TBD|N/A|NA|PASS\s*/\s*FAIL)$')
}

function New-LiveAppEvidenceCheck {
  <#
    Function: Builds one machine-readable evidence section check row.
    Inputs:
      Name: Short check name used in JSON summaries.
      Heading: Required markdown section heading.
      Content: Full evidence file content.
      RequiredFields: Bullet labels that must have meaningful values.
    Output:
      Object containing the check name, required heading, pass/fail status, and missing fields.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string] $Name,
    [string] $Heading,
    [string] $Content,
    [string[]] $RequiredFields
  )

  $body = Get-LiveAppEvidenceSectionBody -Content $Content -Heading $Heading
  $missingFields = [System.Collections.Generic.List[string]]::new()
  if ([string]::IsNullOrWhiteSpace($body)) {
    $missingFields.Add('section') | Out-Null
  } else {
    foreach ($field in $RequiredFields) {
      if (-not (Test-LiveAppEvidenceFieldFilled -Body $body -Label $field)) {
        $missingFields.Add($field) | Out-Null
      }
    }
    if (-not (Test-LiveAppEvidenceResultPass -Body $body)) {
      $missingFields.Add('Result: PASS') | Out-Null
    }
  }
  $passed = $missingFields.Count -eq 0
  return [pscustomobject]@{
    name             = $Name
    required_heading = $Heading
    passed           = $passed
    missing_fields   = @($missingFields)
  }
}

function Get-LiveAppEvidenceStatus {
  <#
    Function: Checks whether a durable live App evidence file proves all live App sections.
    Inputs:
      Path: Optional local path to the operator's live App evidence notes.
    Output:
      Object with Ready, ResolvedPath, and Evidence fields for audit rows and JSON summary.
    Side effects:
      Reads one local evidence file when supplied.
    Errors:
      None; missing or invalid evidence is returned as Ready=false so all gates can still be summarized.
  #>
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return [pscustomobject]@{
      Ready        = $false
      ResolvedPath = ''
      Evidence     = '-LiveAppEvidencePath was not supplied.'
      Checks       = @()
    }
  }

  try {
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path $resolved -PathType Leaf)) {
      return [pscustomobject]@{
        Ready        = $false
        ResolvedPath = $resolved
        Evidence     = "Evidence file was not found at $resolved."
        Checks       = @()
      }
    }
    $content = Get-Content -Raw $resolved
    if ([string]::IsNullOrWhiteSpace($content)) {
      return [pscustomobject]@{
        Ready        = $false
        ResolvedPath = $resolved
        Evidence     = "Evidence file exists but is empty at $resolved."
        Checks       = @()
      }
    }
    $checks = @(
      New-LiveAppEvidenceCheck `
        -Name 'prompt_skill_path' `
        -Heading 'Prompt Skill Path Evidence' `
        -Content $content `
        -RequiredFields @(
          'Prompt Skill id',
          'Trigger message sent',
          'Visible reply summary',
          'Evidence that product-agent received `agent_config.skills`',
          'Screenshot or recording path'
        )
      New-LiveAppEvidenceCheck `
        -Name 'memory_path' `
        -Heading 'Memory Path Evidence' `
        -Content $content `
        -RequiredFields @(
          'Saved card title/body',
          'Conversation or room id used for memory',
          'Evidence that `plugins.invoke -> agent.memory.save` ran',
          'Product-agent memory item id',
          'Screenshot or recording path'
        )
      New-LiveAppEvidenceCheck `
        -Name 'card_rendering_path' `
        -Heading 'Card Rendering Path Evidence' `
        -Content $content `
        -RequiredFields @(
          'Trigger message',
          'Visible card title/body',
          'Confirmation that no raw JSON bubble appeared',
          'Screenshot or recording path'
        )
    )
    $failed = @($checks | Where-Object { -not $_.passed })
    if ($failed.Count -gt 0) {
      $failedNames = ($failed | ForEach-Object {
          "$($_.required_heading) missing [$($_.missing_fields -join ', ')]"
        }) -join '; '
      return [pscustomobject]@{
        Ready        = $false
        ResolvedPath = $resolved
        Evidence     = "Evidence file is incomplete: $failedNames."
        Checks       = $checks
      }
    }
    return [pscustomobject]@{
      Ready        = $true
      ResolvedPath = $resolved
      Evidence     = "Live App evidence file has required fields and PASS results for Prompt Skill, Memory, and Card Rendering: $resolved."
      Checks       = $checks
    }
  } catch {
    return [pscustomobject]@{
      Ready        = $false
      ResolvedPath = $Path
      Evidence     = "Evidence file could not be read: $($_.Exception.Message)"
      Checks       = @()
    }
  }
}

function Write-AuditSummaryJson {
  <#
    Function: Writes a machine-readable completion audit summary when requested.
    Inputs:
      Path: Output JSON path supplied by the operator.
      BlockingGates: Gate rows that did not pass.
      Complete: Whether every gate passed in this audit run.
      AuditFinished: Whether the audit reached the final summary section.
    Output:
      None.
    Side effects:
      Creates the parent directory when needed and writes one UTF-8 JSON file.
    Errors:
      Throws when the path cannot be resolved or written.
  #>
  param(
    [string] $Path,
    [object[]] $BlockingGates,
    [bool] $Complete,
    [bool] $AuditFinished
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $resolved
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  $summary = [pscustomobject]@{
    schema                       = 'direxio.agent_memory_prompt_skill_audit.v1'
    generated_at_utc             = (Get-Date).ToUniversalTime().ToString('o')
    node_domain                  = $NodeDomain
    ssh_user                     = $SshUser
    remote_dir                   = $RemoteDir
    report_only                  = [bool]$ReportOnly
    skip_local_verifier          = [bool]$SkipLocalVerifier
    skip_remote_readiness        = [bool]$SkipRemoteReadiness
    live_app_prompt_skill_flag   = [bool]$LiveAppPromptSkillVerified
    live_app_memory_flag         = [bool]$LiveAppMemoryVerified
    live_app_card_rendering_flag = [bool]$LiveAppCardRenderingVerified
    live_app_evidence_path       = $LiveAppEvidenceStatus.ResolvedPath
    live_app_evidence_present    = [bool]$LiveAppEvidenceStatus.Ready
    live_app_evidence_checks     = @($LiveAppEvidenceStatus.Checks)
    audit_finished               = $AuditFinished
    complete                     = $Complete
    gate_count                   = $GateResults.Count
    blocking_gate_count          = $BlockingGates.Count
    gates                        = @($GateResults)
    blocking_gates               = @($BlockingGates)
  }

  $summary | ConvertTo-Json -Depth 6 | Set-Content -Path $resolved -Encoding utf8
  Write-Host "Wrote audit JSON summary: $resolved"
}

function Write-CurrentAuditSummaryJson {
  <#
    Function: Writes the current gate state to the optional audit summary JSON path.
    Inputs:
      AuditFinished: Whether this is the final audit summary.
    Output:
      None.
    Side effects:
      Writes the optional summary JSON file when SummaryJsonPath is set.
    Errors:
      Propagates write errors from Write-AuditSummaryJson.
  #>
  param([bool] $AuditFinished)

  $currentBlocking = @($GateResults | Where-Object { $_.Status -ne 'PASS' })
  $currentComplete = ($AuditFinished -and $currentBlocking.Count -eq 0)
  Write-AuditSummaryJson `
    -Path $SummaryJsonPath `
    -BlockingGates $currentBlocking `
    -Complete $currentComplete `
    -AuditFinished $AuditFinished
}

$localVerifier = Join-Path $ScriptDir 'verify-agent-memory-skill-loop.ps1'
$readinessInspect = Join-Path $ScriptDir 'inspect-agent-stack-readiness.ps1'

Assert-ScriptExists -Path $localVerifier
Assert-ScriptExists -Path $readinessInspect

$LiveAppEvidenceStatus = Get-LiveAppEvidenceStatus -Path $LiveAppEvidencePath

Write-Host "Agent memory + Prompt Skill completion audit"
Write-Host "Node: $SshUser@$NodeDomain"
Write-Host "Remote compose dir: $RemoteDir"
Write-Host "Mode: audit only; no deploy, upload, .env edit, compose up, or restart."
if (-not [string]::IsNullOrWhiteSpace($LiveAppEvidencePath)) {
  Write-Host "Live App evidence: $($LiveAppEvidenceStatus.Evidence)"
}
Write-CurrentAuditSummaryJson -AuditFinished $false

if ($SkipLocalVerifier) {
  Add-GateResult `
    -Gate 'Local verifier' `
    -Status 'SKIPPED' `
    -Evidence 'Skipped by -SkipLocalVerifier; local product-agent, message-server, and Flutter gates are not proven in this audit run.'
} else {
  $localArgs = @()
  $localArgs = Add-OptionalValueArg -CurrentArgs $localArgs -Name '-ProductAgentRepo' -Value $ProductAgentRepo
  $localArgs = Add-OptionalValueArg -CurrentArgs $localArgs -Name '-MessageServerRepo' -Value $MessageServerRepo
  $localArgs = Add-OptionalValueArg -CurrentArgs $localArgs -Name '-FlutterRepo' -Value $FlutterRepo
  $localArgs = Add-OptionalValueArg -CurrentArgs $localArgs -Name '-GoPath' -Value $GoPath
  Invoke-GateScript `
    -Gate 'Local verifier' `
    -ScriptPath $localVerifier `
    -Arguments $localArgs `
    -SuccessEvidence 'Local verifier passed product-agent, message-server, and Flutter Agent memory/Prompt Skill checks.' `
    -FailureEvidence 'Local verifier did not pass; local implementation correctness is not proven.'
}
Write-CurrentAuditSummaryJson -AuditFinished $false

if ($SkipRemoteReadiness) {
  Add-GateResult `
    -Gate 'Remote readiness' `
    -Status 'SKIPPED' `
    -Evidence 'Skipped by -SkipRemoteReadiness; deployed product-agent/message-server gates are not proven in this audit run.'
} else {
  $remoteArgs = @(
    '-NodeDomain', $NodeDomain,
    '-SshUser', $SshUser,
    '-RemoteDir', $RemoteDir,
    '-RequireConfigOnlySmoke',
    '-RequireLatestMessageServerBridge'
  )
  $remoteArgs = Add-OptionalValueArg -CurrentArgs $remoteArgs -Name '-KeyFile' -Value $KeyFile
  Invoke-GateScript `
    -Gate 'Remote readiness' `
    -ScriptPath $readinessInspect `
    -Arguments $remoteArgs `
    -SuccessEvidence 'Remote readiness passed config-only Prompt Skill smoke and latest message-server bridge markers.' `
    -FailureEvidence 'Remote readiness did not pass; deployed stack is not the latest verified build.'
}
Write-CurrentAuditSummaryJson -AuditFinished $false

Add-ManualGate `
  -Gate 'Live App Prompt Skill path' `
  -IsVerified ([bool]$LiveAppPromptSkillVerified) `
  -Evidence 'Operator asserted that a deployed App account created/edited a Prompt Skill and triggered it through Agent chat.' `
  -Missing 'Run the deployed App, create or edit one Prompt Skill, send an Agent chat message that should trigger it, and confirm it flows through agent_config.skills.' `
  -EvidenceStatus $LiveAppEvidenceStatus

Add-ManualGate `
  -Gate 'Live App memory path' `
  -IsVerified ([bool]$LiveAppMemoryVerified) `
  -Evidence 'Operator asserted that saving a structured Agent card persisted locally and synced through plugins.invoke -> agent.memory.save.' `
  -Missing 'Run the deployed App, save one structured Agent card, confirm local Card Collection persistence, and confirm memory sync succeeds through message-server/product-agent.' `
  -EvidenceStatus $LiveAppEvidenceStatus

Add-ManualGate `
  -Gate 'Live App card rendering path' `
  -IsVerified ([bool]$LiveAppCardRenderingVerified) `
  -Evidence 'Operator asserted that the deployed App renders card/capsule output without exposing raw action-result JSON.' `
  -Missing 'Run the deployed App and confirm the visible Agent reply is a card/capsule, not raw direxio.agent_action_result.v1 JSON.' `
  -EvidenceStatus $LiveAppEvidenceStatus
Write-CurrentAuditSummaryJson -AuditFinished $false

Write-Host ""
Write-Host "== Completion Gate Summary =="
$GateResults | Format-Table -AutoSize

$blocking = @($GateResults | Where-Object { $_.Status -ne 'PASS' })
$complete = $blocking.Count -eq 0
Write-AuditSummaryJson -Path $SummaryJsonPath -BlockingGates $blocking -Complete $complete -AuditFinished $true

if ($complete) {
  Write-Host "Agent memory + Prompt Skill objective is fully proven by this audit."
  exit 0
}

Write-Host "Agent memory + Prompt Skill objective is NOT complete. Blocking gates: $($blocking.Count)."
if ($ReportOnly) {
  Write-Host "ReportOnly mode enabled; returning success despite incomplete gates."
  exit 0
}

exit 1
