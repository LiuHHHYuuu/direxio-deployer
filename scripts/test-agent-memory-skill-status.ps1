param(
  [string] $StatusScriptPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($StatusScriptPath)) {
  $StatusScriptPath = Join-Path $ScriptDir 'show-agent-memory-skill-status.ps1'
}

function Assert-ScriptExists {
  <#
    Function: Verifies that the status helper exists before running self-tests.
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
    throw "Required status script was not found at $Path."
  }
}

function Assert-Condition {
  <#
    Function: Fails the status self-test when an expected condition is false.
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

function New-TempStatusDir {
  <#
    Function: Creates an isolated temporary directory for status self-test fixtures.
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
  $path = Join-Path $tempRoot ("direxio-status-test-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $path -Force | Out-Null
  return $path
}

function Remove-TempStatusDir {
  <#
    Function: Removes the temporary status self-test directory after verifying it is inside the OS temp root.
    Inputs:
      Path: Directory created by New-TempStatusDir.
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
    throw "Refusing to remove non-temp status self-test directory: $resolved"
  }

  if (Test-Path $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

function New-GateRow {
  <#
    Function: Builds one gate row for a status summary fixture.
    Inputs:
      Gate: Exact completion gate name.
      Status: Gate status such as PASS, FAIL, PENDING, or SKIPPED.
    Output:
      Gate row object.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string] $Gate,
    [string] $Status
  )

  return [pscustomobject]@{
    Gate     = $Gate
    Status   = $Status
    Evidence = "self-test evidence for $Gate"
  }
}

function Write-AuditSummaryFixture {
  <#
    Function: Writes one audit JSON fixture for the status helper.
    Inputs:
      Path: Output JSON path.
      Complete: Whether the fixture should be treated as complete.
      LocalStatus: Local verifier gate status.
      RemoteStatus: Remote readiness gate status.
      PromptStatus: Live App Prompt Skill gate status.
      MemoryStatus: Live App memory gate status.
      CardStatus: Live App card rendering gate status.
    Output:
      None.
    Side effects:
      Writes one JSON file.
    Errors:
      Propagates file write failures.
  #>
  param(
    [string] $Path,
    [bool] $Complete,
    [string] $LocalStatus,
    [string] $RemoteStatus,
    [string] $PromptStatus,
    [string] $MemoryStatus,
    [string] $CardStatus
  )

  $gates = @(
    New-GateRow -Gate 'Local verifier' -Status $LocalStatus
    New-GateRow -Gate 'Remote readiness' -Status $RemoteStatus
    New-GateRow -Gate 'Live App Prompt Skill path' -Status $PromptStatus
    New-GateRow -Gate 'Live App memory path' -Status $MemoryStatus
    New-GateRow -Gate 'Live App card rendering path' -Status $CardStatus
  )
  $blocking = @($gates | Where-Object { $_.Status -ne 'PASS' })
  $summary = [pscustomobject]@{
    schema              = 'direxio.agent_memory_prompt_skill_audit.v1'
    generated_at_utc    = '2026-07-08T00:00:00.0000000Z'
    complete            = $Complete
    blocking_gate_count = $blocking.Count
    gates               = $gates
    blocking_gates      = $blocking
  }

  $summary | ConvertTo-Json -Depth 6 | Set-Content -Path $Path -Encoding utf8
}

function Invoke-StatusScenario {
  <#
    Function: Runs the status helper for one self-test scenario and captures output.
    Inputs:
      Name: Human-readable scenario name for logs.
      SummaryPath: Optional JSON summary path passed to the helper.
      EvidenceDir: Optional evidence directory passed to the helper.
    Output:
      Object containing the child process exit code and captured output.
    Side effects:
      Executes the local status helper and writes temporary stdout/stderr capture files.
    Errors:
      None; child-process failure is returned to the caller for assertions.
  #>
  param(
    [string] $Name,
    [string] $SummaryPath,
    [string] $EvidenceDir
  )

  Write-Host ""
  Write-Host "==> Status self-test: $Name"
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $StatusScriptPath,
    '-NodeDomain',
    'example.test'
  )
  if (-not [string]::IsNullOrWhiteSpace($SummaryPath)) {
    $arguments += @('-SummaryJsonPath', $SummaryPath)
  }
  if (-not [string]::IsNullOrWhiteSpace($EvidenceDir)) {
    $arguments += @('-EvidenceDir', $EvidenceDir)
  }

  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process `
      -FilePath 'powershell' `
      -ArgumentList $arguments `
      -NoNewWindow `
      -Wait `
      -PassThru `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath
    $stdout = Get-Content -Raw $stdoutPath
    $stderr = Get-Content -Raw $stderrPath
    $processOutput = (($stdout, $stderr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($processOutput)) {
      Write-Host $processOutput
    }
    $exitCode = $process.ExitCode
  } finally {
    if (Test-Path $stdoutPath) { Remove-Item -LiteralPath $stdoutPath -Force }
    if (Test-Path $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
  }

  return [pscustomobject]@{
    exit_code = $exitCode
    output    = $processOutput
  }
}

function Assert-ScenarioOutput {
  <#
    Function: Verifies that one status scenario exits successfully and prints required text.
    Inputs:
      Result: Object returned by Invoke-StatusScenario.
      RequiredPatterns: Regex patterns expected in stdout/stderr.
    Output:
      None.
    Side effects:
      None.
    Errors:
      Throws when the scenario failed or output is missing an expected pattern.
  #>
  param(
    [object] $Result,
    [string[]] $RequiredPatterns
  )

  Assert-Condition -Condition ($Result.exit_code -eq 0) -Message "Expected status helper to exit 0, got $($Result.exit_code)."
  foreach ($pattern in $RequiredPatterns) {
    Assert-Condition -Condition ($Result.output -match $pattern) -Message "Expected status output to match '$pattern'."
  }
}

Assert-ScriptExists -Path $StatusScriptPath

$tempDir = New-TempStatusDir
try {
  $emptyDir = Join-Path $tempDir 'empty-evidence'
  New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
  $noSummary = Invoke-StatusScenario `
    -Name 'no audit summary recommends preflight' `
    -EvidenceDir $emptyDir
  Assert-ScenarioOutput -Result $noSummary -RequiredPatterns @(
    'No audit summary was found',
    'preflight-agent-memory-skill-deploy\.ps1'
  )

  $localFailPath = Join-Path $tempDir 'local-fail.json'
  Write-AuditSummaryFixture `
    -Path $localFailPath `
    -Complete $false `
    -LocalStatus 'FAIL' `
    -RemoteStatus 'SKIPPED' `
    -PromptStatus 'PENDING' `
    -MemoryStatus 'PENDING' `
    -CardStatus 'PENDING'
  $localFail = Invoke-StatusScenario `
    -Name 'local failure recommends fixing local gates' `
    -SummaryPath $localFailPath
  Assert-ScenarioOutput -Result $localFail -RequiredPatterns @(
    'Local verifier: FAIL',
    'Fix local implementation or tests',
    'preflight-agent-memory-skill-deploy\.ps1'
  )

  $remoteFailPath = Join-Path $tempDir 'remote-fail.json'
  Write-AuditSummaryFixture `
    -Path $remoteFailPath `
    -Complete $false `
    -LocalStatus 'PASS' `
    -RemoteStatus 'FAIL' `
    -PromptStatus 'PENDING' `
    -MemoryStatus 'PENDING' `
    -CardStatus 'PENDING'
  $remoteFail = Invoke-StatusScenario `
    -Name 'remote failure recommends guarded deploy' `
    -SummaryPath $remoteFailPath
  Assert-ScenarioOutput -Result $remoteFail -RequiredPatterns @(
    'Remote readiness: FAIL',
    'deploy-agent-memory-skill-stack\.ps1',
    'IUnderstandThisRestartsProductAgent'
  )

  $livePendingPath = Join-Path $tempDir 'live-pending.json'
  Write-AuditSummaryFixture `
    -Path $livePendingPath `
    -Complete $false `
    -LocalStatus 'PASS' `
    -RemoteStatus 'PASS' `
    -PromptStatus 'PENDING' `
    -MemoryStatus 'PENDING' `
    -CardStatus 'PENDING'
  $livePending = Invoke-StatusScenario `
    -Name 'live gates pending recommend evidence workflow' `
    -SummaryPath $livePendingPath
  Assert-ScenarioOutput -Result $livePending -RequiredPatterns @(
    'Remote is ready',
    'new-agent-memory-skill-live-evidence\.ps1',
    'validate-agent-memory-skill-live-evidence\.ps1',
    'audit-agent-memory-skill-goal\.ps1'
  )

  $completePath = Join-Path $tempDir 'complete.json'
  Write-AuditSummaryFixture `
    -Path $completePath `
    -Complete $true `
    -LocalStatus 'PASS' `
    -RemoteStatus 'PASS' `
    -PromptStatus 'PASS' `
    -MemoryStatus 'PASS' `
    -CardStatus 'PASS'
  $complete = Invoke-StatusScenario `
    -Name 'complete summary reports proven completion' `
    -SummaryPath $completePath
  Assert-ScenarioOutput -Result $complete -RequiredPatterns @(
    'Complete: True',
    'Completion is already proven'
  )
} finally {
  Remove-TempStatusDir -Path $tempDir
}

Write-Host ""
Write-Host "Agent memory + Prompt Skill status helper self-tests passed."
