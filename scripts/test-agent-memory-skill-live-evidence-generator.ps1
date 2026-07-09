param(
  [string] $GeneratorScriptPath
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($GeneratorScriptPath)) {
  $GeneratorScriptPath = Join-Path $ScriptDir 'new-agent-memory-skill-live-evidence.ps1'
}

function Assert-ScriptExists {
  <#
    Function: Verifies that the live evidence generator script exists before running self-tests.
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
    throw "Required generator script was not found at $Path."
  }
}

function Assert-Condition {
  <#
    Function: Fails the generator self-test when an expected condition is false.
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

function New-TempGeneratorDir {
  <#
    Function: Creates an isolated temporary directory for generator self-test files.
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
  $path = Join-Path $tempRoot ("direxio-live-evidence-generator-test-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $path -Force | Out-Null
  return $path
}

function Remove-TempGeneratorDir {
  <#
    Function: Removes the temporary generator self-test directory after verifying it is inside the OS temp root.
    Inputs:
      Path: Directory created by New-TempGeneratorDir.
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
    throw "Refusing to remove non-temp generator self-test directory: $resolved"
  }

  if (Test-Path $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

function Invoke-GeneratorScenario {
  <#
    Function: Runs the live evidence generator for one self-test scenario.
    Inputs:
      Name: Human-readable scenario name for logs.
      OutputPath: Evidence output path passed to the generator.
      Force: Whether to pass the generator's -Force flag.
    Output:
      Object containing the child process exit code and captured output.
    Side effects:
      Executes the local generator script, writes temporary stdout/stderr capture files, and may write one evidence markdown file.
    Errors:
      None; child-process failure is returned to the caller for assertions.
  #>
  param(
    [string] $Name,
    [string] $OutputPath,
    [bool] $Force = $false
  )

  Write-Host ""
  Write-Host "==> Evidence generator self-test: $Name"
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $GeneratorScriptPath,
    '-OutputPath',
    $OutputPath,
    '-NodeDomain',
    'example.test',
    '-OwnerAccount',
    '@owner:example.test',
    '-AppBuildVersion',
    'self-test-build',
    '-AgentRoomId',
    '!agent:example.test',
    '-EvidenceFolder',
    'C:\tmp\direxio-evidence'
  )
  if ($Force) {
    $arguments += '-Force'
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

function Assert-EvidenceContentPrefilled {
  <#
    Function: Verifies that generated evidence content contains the expected setup metadata.
    Inputs:
      Path: Generated evidence markdown path.
    Output:
      None.
    Side effects:
      Reads one local markdown file.
    Errors:
      Throws when the file is missing or required values are not present.
  #>
  param([string] $Path)

  Assert-Condition -Condition (Test-Path $Path -PathType Leaf) -Message "Generated evidence file was not created at $Path."
  $content = Get-Content -Raw $Path
  Assert-Condition -Condition ($content -match 'Node/domain: example\.test') -Message 'Node/domain was not prefilled.'
  Assert-Condition -Condition ($content -match 'Owner account: @owner:example\.test') -Message 'Owner account was not prefilled.'
  Assert-Condition -Condition ($content -match 'App build/version: self-test-build') -Message 'App build/version was not prefilled.'
  Assert-Condition -Condition ($content -match 'Agent room id: !agent:example\.test') -Message 'Agent room id was not prefilled.'
  Assert-Condition -Condition ($content -match 'Evidence screenshots or recording folder: C:\\tmp\\direxio-evidence') -Message 'Evidence folder was not prefilled.'
}

Assert-ScriptExists -Path $GeneratorScriptPath

$tempDir = New-TempGeneratorDir
try {
  $evidencePath = Join-Path $tempDir 'live-evidence.md'

  $created = Invoke-GeneratorScenario `
    -Name 'creates and pre-fills evidence file' `
    -OutputPath $evidencePath
  Assert-Condition -Condition ($created.exit_code -eq 0) -Message "Expected generator creation to pass, got exit code $($created.exit_code)."
  Assert-EvidenceContentPrefilled -Path $evidencePath

  $rejected = Invoke-GeneratorScenario `
    -Name 'rejects overwrite without Force' `
    -OutputPath $evidencePath
  Assert-Condition -Condition ($rejected.exit_code -ne 0) -Message 'Expected generator to reject overwriting an existing evidence file.'
  Assert-Condition -Condition ($rejected.output -match 'Refusing to overwrite existing evidence file') -Message 'Overwrite rejection did not print the expected reason.'

  $forced = Invoke-GeneratorScenario `
    -Name 'allows overwrite with Force' `
    -OutputPath $evidencePath `
    -Force $true
  Assert-Condition -Condition ($forced.exit_code -eq 0) -Message "Expected generator Force overwrite to pass, got exit code $($forced.exit_code)."
  Assert-EvidenceContentPrefilled -Path $evidencePath
} finally {
  Remove-TempGeneratorDir -Path $tempDir
}

Write-Host ""
Write-Host "Agent memory + Prompt Skill live evidence generator self-tests passed."
