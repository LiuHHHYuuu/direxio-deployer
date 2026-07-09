param(
  [string] $ProductAgentRepo,
  [string] $MessageServerRepo,
  [string] $FlutterRepo,
  [string] $GoPath,
  [switch] $SkipProductAgent,
  [switch] $SkipMessageServer,
  [switch] $SkipFlutter
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$WorkspaceRoot = Split-Path -Parent $RepoRoot

function Resolve-RepoPath {
  <#
    Function: Resolves one repository path used by the local agent loop verifier.
    Inputs:
      Candidate: Optional user-provided path.
      DefaultPath: Expected path relative to this workspace.
      RequiredChild: File or directory that must exist inside the repository.
    Output:
      Absolute repository path.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when the repository cannot be found.
  #>
  param(
    [string] $Candidate,
    [string] $DefaultPath,
    [string] $RequiredChild
  )

  $paths = @()
  if ($Candidate) { $paths += $Candidate }
  $paths += $DefaultPath

  foreach ($path in $paths) {
    if (-not $path) { continue }
    $resolved = [System.IO.Path]::GetFullPath($path)
    if ((Test-Path $resolved) -and (Test-Path (Join-Path $resolved $RequiredChild))) {
      return $resolved
    }
  }

  throw "Could not resolve repository containing '$RequiredChild'. Pass an explicit path."
}

function Resolve-GoCommand {
  <#
    Function: Finds the Go executable for message-server checks.
    Inputs:
      Candidate: Optional explicit go.exe path.
    Output:
      Command path suitable for PowerShell invocation.
    Side effects:
      Reads PATH and common Windows install locations.
    Errors:
      Throws when Go is unavailable.
  #>
  param([string] $Candidate)

  if ($Candidate) {
    $resolved = [System.IO.Path]::GetFullPath($Candidate)
    if (Test-Path $resolved) { return $resolved }
    throw "Go executable was not found at $resolved."
  }

  $cmd = Get-Command go -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  $fallbacks = @(
    'C:\Program Files\Go\bin\go.exe',
    'C:\Program Files (x86)\Go\bin\go.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Go\bin\go.exe')
  )
  foreach ($path in $fallbacks) {
    if (Test-Path $path) { return $path }
  }

  throw "Go was not found. Install Go or pass -GoPath <path-to-go.exe>."
}

function Invoke-InRepo {
  <#
    Function: Runs one validation command inside a repository and fails fast.
    Inputs:
      Label: Human-readable step label.
      Repo: Working directory.
      Command: Executable or script name.
      CommandArgs: Command arguments.
    Output:
      None.
    Side effects:
      Runs local test/build commands and streams their output.
    Errors:
      Throws when the command exits non-zero.
  #>
  param(
    [string] $Label,
    [string] $Repo,
    [string] $Command,
    [string[]] $CommandArgs = @()
  )

  Write-Host ""
  Write-Host "==> $Label"
  Push-Location $Repo
  try {
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) {
      throw "$Label failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

function Assert-PowerShellScriptParses {
  <#
    Function: Verifies that one PowerShell harness script has no parser errors.
    Inputs:
      Path: Script path to parse.
    Output:
      None.
    Side effects:
      Reads the script file; does not execute it.
    Errors:
      Throws when the script is missing or contains parser errors.
  #>
  param([string] $Path)

  if (-not (Test-Path $Path)) {
    throw "PowerShell script was not found at $Path."
  }

  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $Path),
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count -gt 0) {
    $messages = ($errors | ForEach-Object { $_.Message }) -join '; '
    throw "PowerShell parser errors in ${Path}: $messages"
  }
}

function Remove-MessageServerBuildArtifact {
  <#
    Function: Removes local message-server binaries created by `go build`.
    Inputs:
      Repo: Local message-server repository path.
    Output:
      None.
    Side effects:
      Deletes only the known root-level build artifacts produced by this verifier.
    Errors:
      Propagates unexpected filesystem errors.
  #>
  param([string] $Repo)

  $artifacts = @(
    (Join-Path $Repo 'dirextalk-message-server.exe'),
    (Join-Path $Repo 'dirextalk-message-server')
  )
  foreach ($artifact in $artifacts) {
    if (Test-Path $artifact) {
      Remove-Item -LiteralPath $artifact -Force
    }
  }
}

$productAgentPath = Resolve-RepoPath `
  -Candidate $ProductAgentRepo `
  -DefaultPath (Join-Path $RepoRoot 'product-agent') `
  -RequiredChild 'package.json'
$messageServerPath = Resolve-RepoPath `
  -Candidate $MessageServerRepo `
  -DefaultPath (Join-Path $WorkspaceRoot 'dirextalk-message-server') `
  -RequiredChild 'cmd\dirextalk-message-server'
$flutterPath = Resolve-RepoPath `
  -Candidate $FlutterRepo `
  -DefaultPath (Join-Path $WorkspaceRoot 'direxio-flutter') `
  -RequiredChild 'pubspec.yaml'
$go = Resolve-GoCommand -Candidate $GoPath

Write-Host "Product-agent repo: $productAgentPath"
Write-Host "Message-server repo: $messageServerPath"
Write-Host "Flutter repo: $flutterPath"
Write-Host "Go command: $go"

$harnessScripts = @(
  'audit-agent-memory-skill-goal.ps1',
  'deploy-agent-memory-skill-stack.ps1',
  'deploy-message-server-product-agent-bridge.ps1',
  'deploy-product-agent-image.ps1',
  'install-latest-flutter-apk.ps1',
  'inspect-agent-stack-readiness.ps1',
  'new-agent-memory-skill-live-evidence.ps1',
  'preflight-agent-memory-skill-deploy.ps1',
  'show-agent-memory-skill-status.ps1',
  'test-agent-memory-skill-audit.ps1',
  'test-agent-memory-skill-live-evidence-generator.ps1',
  'test-agent-memory-skill-status.ps1',
  'validate-agent-memory-skill-live-evidence.ps1',
  'verify-agent-memory-skill-loop.ps1'
)
Write-Host ""
Write-Host "==> PowerShell harness parser checks"
foreach ($scriptName in $harnessScripts) {
  Assert-PowerShellScriptParses -Path (Join-Path $ScriptDir $scriptName)
}

Invoke-InRepo "completion audit evidence self-tests" $RepoRoot "powershell" @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $ScriptDir "test-agent-memory-skill-audit.ps1")
)

Invoke-InRepo "live evidence generator self-tests" $RepoRoot "powershell" @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $ScriptDir "test-agent-memory-skill-live-evidence-generator.ps1")
)

Invoke-InRepo "status helper self-tests" $RepoRoot "powershell" @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (Join-Path $ScriptDir "test-agent-memory-skill-status.ps1")
)

if (-not $SkipProductAgent) {
  Invoke-InRepo "product-agent typecheck" $productAgentPath "npm" @("run", "check")
  Invoke-InRepo "product-agent contract tests" $productAgentPath "npm" @("test")
  Invoke-InRepo "product-agent build" $productAgentPath "npm" @("run", "build")
  Invoke-InRepo "product-agent memory + Prompt Skill smoke" $productAgentPath "npm" @("run", "smoke:memory-skill")
}

if (-not $SkipMessageServer) {
  Invoke-InRepo "message-server product-agent bridge tests" $messageServerPath $go @(
    "test",
    "./p2p",
    "-run",
    "TestHTTPProductAgentClient|TestProductAgentClientFromConfig|TestProductAgentReplyMatrixPayload|TestProjectAgentRoomMessage|TestPluginActionAllowlistIncludesAgentMemoryActions|TestPluginInvokeAgentMemory|TestPluginConfigUpdateReappliesEnabledPluginRuntime|TestPluginModelProfileAPIKeyIsInvokeOnly",
    "-count=1"
  )
  try {
    Invoke-InRepo "message-server build" $messageServerPath $go @("build", "./cmd/dirextalk-message-server")
  } finally {
    Remove-MessageServerBuildArtifact -Repo $messageServerPath
  }
}

if (-not $SkipFlutter) {
  Invoke-InRepo "Flutter Agent card and Prompt Skill UI tests" $flutterPath "flutter" @(
    "test",
    "test\agent_message_content_test.dart",
    "test\agent_message_body_test.dart",
    "test\plugin_management_page_test.dart",
    "test\agent_card_collection_store_test.dart",
    "test\agent_card_collection_provider_test.dart"
  )
}

Write-Host ""
Write-Host "Agent memory + Prompt Skill local loop verification passed."
