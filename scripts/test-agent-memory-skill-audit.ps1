param(
  [string] $AuditScriptPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($AuditScriptPath)) {
  $AuditScriptPath = Join-Path $ScriptDir 'audit-agent-memory-skill-goal.ps1'
}

function Assert-ScriptExists {
  <#
    Function: Verifies that the completion audit script exists before running self-tests.
    Inputs:
      Path: Absolute or relative PowerShell script path.
    Output:
      None.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when the script path is missing.
  #>
  param([string] $Path)

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "Required audit script was not found at $Path."
  }
}

function Assert-Condition {
  <#
    Function: Fails the self-test when an expected condition is false.
    Inputs:
      Condition: Boolean expression result.
      Message: Explanation printed when the assertion fails.
    Output:
      None.
    Side effects:
      None.
    Errors:
      Throws with the supplied message when Condition is false.
  #>
  param(
    [bool] $Condition,
    [string] $Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function New-TempAuditDir {
  <#
    Function: Creates an isolated temporary directory for audit summaries and evidence fixtures.
    Inputs:
      None.
    Output:
      Absolute temporary directory path.
    Side effects:
      Creates one directory under the OS temp directory.
    Errors:
      Propagates filesystem creation failures.
  #>
  $tempRoot = [System.IO.Path]::GetTempPath()
  $path = Join-Path $tempRoot ("direxio-agent-audit-test-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $path -Force | Out-Null
  return $path
}

function Remove-TempAuditDir {
  <#
    Function: Removes the temporary audit self-test directory after verifying it is inside the OS temp root.
    Inputs:
      Path: Directory created by New-TempAuditDir.
    Output:
      None.
    Side effects:
      Recursively deletes only the verified temporary test directory.
    Errors:
      Throws if the path is outside the OS temp directory or deletion fails.
  #>
  param([string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (-not $resolved.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove non-temp audit self-test directory: $resolved"
  }

  if (Test-Path $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

function Write-PassEmptyFieldsEvidenceFile {
  <#
    Function: Writes an invalid evidence fixture whose sections say PASS but leave required fields empty.
    Inputs:
      Path: Output markdown path for the fixture.
    Output:
      None.
    Side effects:
      Writes one markdown evidence file.
    Errors:
      Propagates file write failures.
  #>
  param([string] $Path)

  @'
# Agent Memory and Prompt Skill Live App Evidence

## Prompt Skill Path Evidence

- Prompt Skill id:
- Trigger message sent:
- Visible reply summary:
- Evidence that product-agent received `agent_config.skills`:
- Screenshot or recording path:
- Result: PASS

## Memory Path Evidence

- Saved card title/body:
- Conversation or room id used for memory:
- Evidence that `plugins.invoke -> agent.memory.save` ran:
- Product-agent memory item id:
- Screenshot or recording path:
- Result: PASS

## Card Rendering Path Evidence

- Trigger message:
- Visible card title/body:
- Confirmation that no raw JSON bubble appeared:
- Screenshot or recording path:
- Result: PASS
'@ | Set-Content -Path $Path -Encoding utf8
}

function Write-ValidEvidenceFile {
  <#
    Function: Writes a valid evidence fixture with non-placeholder values for every required live App field.
    Inputs:
      Path: Output markdown path for the fixture.
    Output:
      None.
    Side effects:
      Writes one markdown evidence file.
    Errors:
      Propagates file write failures.
  #>
  param([string] $Path)

  @'
# Agent Memory and Prompt Skill Live App Evidence

## Prompt Skill Path Evidence

- Prompt Skill id: skill_project_status_digest
- Trigger message sent: Use the project status digest skill for today's update
- Visible reply summary: Returned a concise project status digest
- Evidence that product-agent received `agent_config.skills`: product-agent log request local-self-test-agent-config-skills
- Screenshot or recording path: C:\tmp\direxio-prompt-skill-pass.png
- Result: PASS

## Memory Path Evidence

- Saved card title/body: Today status / saved to memory capsule
- Conversation or room id used for memory: !agent-self-test-room:example.test
- Evidence that `plugins.invoke -> agent.memory.save` ran: message-server log action agent.memory.save request local-self-test-memory-save
- Product-agent memory item id: mem_self_test_001
- Screenshot or recording path: C:\tmp\direxio-memory-pass.png
- Result: PASS

## Card Rendering Path Evidence

- Trigger message: Generate a today status card
- Visible card title/body: Today status / three action items
- Confirmation that no raw JSON bubble appeared: Only the rendered card appeared; raw direxio.agent_action_result.v1 JSON was not visible
- Screenshot or recording path: C:\tmp\direxio-card-rendering-pass.png
- Result: PASS
'@ | Set-Content -Path $Path -Encoding utf8
}

function Read-SummaryJson {
  <#
    Function: Reads the machine-readable audit summary produced by the completion audit script.
    Inputs:
      Path: JSON summary path passed to the audit script.
    Output:
      Parsed PowerShell object for assertions.
    Side effects:
      Reads one local JSON file.
    Errors:
      Throws when the file is missing or invalid JSON.
  #>
  param([string] $Path)

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "Audit summary was not written at $Path."
  }
  return Get-Content -Raw $Path | ConvertFrom-Json
}

function Invoke-AuditScenario {
  <#
    Function: Runs the completion audit in ReportOnly mode for one fixture scenario.
    Inputs:
      Name: Human-readable scenario name for logs.
      SummaryPath: JSON summary path to write.
      EvidencePath: Optional markdown live App evidence fixture.
    Output:
      Parsed audit summary object.
    Side effects:
      Executes the local audit script with local and remote gates skipped; writes one JSON summary.
    Errors:
      Throws when the audit process exits non-zero or the summary cannot be read.
  #>
  param(
    [string] $Name,
    [string] $SummaryPath,
    [string] $EvidencePath
  )

  Write-Host ""
  Write-Host "==> Audit self-test: $Name"
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
    '-ReportOnly',
    '-SummaryJsonPath',
    $SummaryPath
  )

  if (-not [string]::IsNullOrWhiteSpace($EvidencePath)) {
    $arguments += @('-LiveAppEvidencePath', $EvidencePath)
  }

  $processOutput = & powershell @arguments
  $exitCode = $LASTEXITCODE
  $processOutput | ForEach-Object { Write-Host $_ }
  if ($exitCode -ne 0) {
    throw "Audit self-test scenario '$Name' failed with exit code $exitCode."
  }

  return Read-SummaryJson -Path $SummaryPath
}

function Get-AuditGate {
  <#
    Function: Finds one gate row in a parsed audit summary.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Exact gate name.
    Output:
      Gate row object.
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
  Assert-Condition -Condition ($matches.Count -eq 1) -Message "Expected exactly one '$Gate' gate, found $($matches.Count)."
  return $matches[0]
}

function Assert-GateStatus {
  <#
    Function: Verifies one gate status in an audit summary.
    Inputs:
      Summary: Parsed audit summary object.
      Gate: Exact gate name.
      ExpectedStatus: Required status value.
    Output:
      None.
    Side effects:
      None.
    Errors:
      Throws when the gate status differs.
  #>
  param(
    [object] $Summary,
    [string] $Gate,
    [string] $ExpectedStatus
  )

  $gateRow = Get-AuditGate -Summary $Summary -Gate $Gate
  Assert-Condition `
    -Condition ($gateRow.Status -eq $ExpectedStatus) `
    -Message "Expected gate '$Gate' to be $ExpectedStatus, got $($gateRow.Status)."
}

function Get-LiveEvidenceCheck {
  <#
    Function: Finds one live App evidence check in an audit summary.
    Inputs:
      Summary: Parsed audit summary object.
      Name: Exact evidence check name.
    Output:
      Evidence check row object.
    Side effects:
      None.
    Errors:
      Throws when the check is missing or duplicated.
  #>
  param(
    [object] $Summary,
    [string] $Name
  )

  $matches = @($Summary.live_app_evidence_checks | Where-Object { $_.name -eq $Name })
  Assert-Condition -Condition ($matches.Count -eq 1) -Message "Expected exactly one '$Name' evidence check, found $($matches.Count)."
  return $matches[0]
}

function Assert-LiveEvidenceCheck {
  <#
    Function: Verifies one live App evidence check pass/fail result and missing-field details.
    Inputs:
      Summary: Parsed audit summary object.
      Name: Exact evidence check name.
      ExpectedPassed: Required pass state.
    Output:
      None.
    Side effects:
      None.
    Errors:
      Throws when pass state or missing-field details do not match expectations.
  #>
  param(
    [object] $Summary,
    [string] $Name,
    [bool] $ExpectedPassed
  )

  $check = Get-LiveEvidenceCheck -Summary $Summary -Name $Name
  Assert-Condition `
    -Condition ([bool]$check.passed -eq $ExpectedPassed) `
    -Message "Expected evidence check '$Name' passed=$ExpectedPassed, got $($check.passed)."

  if ($ExpectedPassed) {
    Assert-Condition `
      -Condition (@($check.missing_fields).Count -eq 0) `
      -Message "Expected evidence check '$Name' to have no missing fields."
  } else {
    Assert-Condition `
      -Condition (@($check.missing_fields).Count -gt 0) `
      -Message "Expected evidence check '$Name' to report missing fields."
  }
}

Assert-ScriptExists -Path $AuditScriptPath

$tempDir = New-TempAuditDir
try {
  $missingEvidenceSummary = Join-Path $tempDir 'missing-evidence-summary.json'
  $missingEvidence = Invoke-AuditScenario `
    -Name 'live flags without evidence path must not pass' `
    -SummaryPath $missingEvidenceSummary
  Assert-Condition -Condition (-not [bool]$missingEvidence.live_app_evidence_present) -Message 'Missing evidence scenario should not report live_app_evidence_present=true.'
  Assert-GateStatus -Summary $missingEvidence -Gate 'Live App Prompt Skill path' -ExpectedStatus 'FAIL'
  Assert-GateStatus -Summary $missingEvidence -Gate 'Live App memory path' -ExpectedStatus 'FAIL'
  Assert-GateStatus -Summary $missingEvidence -Gate 'Live App card rendering path' -ExpectedStatus 'FAIL'

  $emptyFieldsPath = Join-Path $tempDir 'empty-fields-evidence.md'
  $emptyFieldsSummary = Join-Path $tempDir 'empty-fields-summary.json'
  Write-PassEmptyFieldsEvidenceFile -Path $emptyFieldsPath
  $emptyFields = Invoke-AuditScenario `
    -Name 'PASS lines with empty required fields must not pass' `
    -SummaryPath $emptyFieldsSummary `
    -EvidencePath $emptyFieldsPath
  Assert-Condition -Condition (-not [bool]$emptyFields.live_app_evidence_present) -Message 'Empty fields scenario should not report live_app_evidence_present=true.'
  Assert-GateStatus -Summary $emptyFields -Gate 'Live App Prompt Skill path' -ExpectedStatus 'FAIL'
  Assert-GateStatus -Summary $emptyFields -Gate 'Live App memory path' -ExpectedStatus 'FAIL'
  Assert-GateStatus -Summary $emptyFields -Gate 'Live App card rendering path' -ExpectedStatus 'FAIL'
  Assert-LiveEvidenceCheck -Summary $emptyFields -Name 'prompt_skill_path' -ExpectedPassed $false
  Assert-LiveEvidenceCheck -Summary $emptyFields -Name 'memory_path' -ExpectedPassed $false
  Assert-LiveEvidenceCheck -Summary $emptyFields -Name 'card_rendering_path' -ExpectedPassed $false

  $validEvidencePath = Join-Path $tempDir 'valid-evidence.md'
  $validEvidenceSummary = Join-Path $tempDir 'valid-summary.json'
  Write-ValidEvidenceFile -Path $validEvidencePath
  $validEvidence = Invoke-AuditScenario `
    -Name 'filled evidence with PASS lines should pass live gates' `
    -SummaryPath $validEvidenceSummary `
    -EvidencePath $validEvidencePath
  Assert-Condition -Condition ([bool]$validEvidence.live_app_evidence_present) -Message 'Valid evidence scenario should report live_app_evidence_present=true.'
  Assert-GateStatus -Summary $validEvidence -Gate 'Live App Prompt Skill path' -ExpectedStatus 'PASS'
  Assert-GateStatus -Summary $validEvidence -Gate 'Live App memory path' -ExpectedStatus 'PASS'
  Assert-GateStatus -Summary $validEvidence -Gate 'Live App card rendering path' -ExpectedStatus 'PASS'
  Assert-LiveEvidenceCheck -Summary $validEvidence -Name 'prompt_skill_path' -ExpectedPassed $true
  Assert-LiveEvidenceCheck -Summary $validEvidence -Name 'memory_path' -ExpectedPassed $true
  Assert-LiveEvidenceCheck -Summary $validEvidence -Name 'card_rendering_path' -ExpectedPassed $true
} finally {
  Remove-TempAuditDir -Path $tempDir
}

Write-Host ""
Write-Host "Agent memory + Prompt Skill completion audit self-tests passed."
