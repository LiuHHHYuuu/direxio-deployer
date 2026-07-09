param(
  [string] $ProductAgentRepo,
  [string] $MessageServerRepo,
  [string] $FlutterRepo,
  [string] $NodeDomain = 'codex1.p2pagent.im',
  [string] $SshUser = 'ubuntu',
  [string] $KeyFile,
  [string] $RemoteDir = '/var/direxio-message-server',
  [string] $ImageTag,
  [string] $GoPath,
  [switch] $Apply,
  [switch] $IUnderstandThisRestartsProductAgent,
  [switch] $IUnderstandThisRestartsMessageServer,
  [switch] $SkipProductAgentLocalVerifier,
  [switch] $SkipMessageServerLocalVerifier,
  [switch] $SkipFlutterVerifier,
  [switch] $SkipContainerSmoke
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-ScriptExists {
  <#
    Function: Verifies that a required local deployment helper exists.
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

function Invoke-ChildScript {
  <#
    Function: Runs one guarded child script and stops on failure.
    Inputs:
      Label: Human-readable step name.
      ScriptPath: Child PowerShell script path.
      Arguments: Argument array passed to the child script.
    Output:
      Child script output is streamed to the terminal.
    Side effects:
      Depends on the child script; in dry-run mode the called scripts avoid deploys, and in Apply mode they may build, upload, restart, and inspect the remote node.
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

$productAgentDeploy = Join-Path $ScriptDir 'deploy-product-agent-image.ps1'
$messageServerDeploy = Join-Path $ScriptDir 'deploy-message-server-product-agent-bridge.ps1'
$readinessInspect = Join-Path $ScriptDir 'inspect-agent-stack-readiness.ps1'

Assert-ScriptExists -Path $productAgentDeploy
Assert-ScriptExists -Path $messageServerDeploy
Assert-ScriptExists -Path $readinessInspect

Write-Host "Agent memory + Prompt Skill stack deploy orchestrator"
Write-Host "Node: $SshUser@$NodeDomain"
Write-Host "Remote compose dir: $RemoteDir"

if (-not $Apply) {
  Write-Host ""
  Write-Host "Dry-run only. No build, upload, .env edit, container restart, or remote deploy was performed."
  Write-Host "This will run child deploy scripts in their own dry-run mode so their paths and guardrails are visible."
  Write-Host "To deploy, re-run with -Apply -IUnderstandThisRestartsProductAgent -IUnderstandThisRestartsMessageServer."
}

if ($Apply -and -not $IUnderstandThisRestartsProductAgent) {
  throw "Refusing to deploy. Re-run with -IUnderstandThisRestartsProductAgent to confirm the product-agent restart."
}

if ($Apply -and -not $IUnderstandThisRestartsMessageServer) {
  throw "Refusing to deploy. Re-run with -IUnderstandThisRestartsMessageServer to confirm the message-server restart."
}

$sharedArgs = @(
  '-NodeDomain', $NodeDomain,
  '-SshUser', $SshUser,
  '-RemoteDir', $RemoteDir
)
$sharedArgs = Add-OptionalValueArg -CurrentArgs $sharedArgs -Name '-KeyFile' -Value $KeyFile

$productArgs = $sharedArgs
$productArgs = Add-OptionalValueArg -CurrentArgs $productArgs -Name '-ProductAgentRepo' -Value $ProductAgentRepo
$productArgs = Add-OptionalValueArg -CurrentArgs $productArgs -Name '-MessageServerRepo' -Value $MessageServerRepo
$productArgs = Add-OptionalValueArg -CurrentArgs $productArgs -Name '-FlutterRepo' -Value $FlutterRepo
$productArgs = Add-OptionalValueArg -CurrentArgs $productArgs -Name '-ImageTag' -Value $ImageTag
$productArgs = Add-OptionalValueArg -CurrentArgs $productArgs -Name '-GoPath' -Value $GoPath
if ($Apply) { $productArgs += @('-Apply', '-IUnderstandThisRestartsProductAgent') }
if ($SkipProductAgentLocalVerifier) { $productArgs += '-SkipLocalVerifier' }
if ($SkipFlutterVerifier) { $productArgs += '-SkipFlutterVerifier' }
if ($SkipContainerSmoke) { $productArgs += '-SkipContainerSmoke' }

$messageArgs = $sharedArgs
$messageArgs = Add-OptionalValueArg -CurrentArgs $messageArgs -Name '-MessageServerRepo' -Value $MessageServerRepo
$messageArgs = Add-OptionalValueArg -CurrentArgs $messageArgs -Name '-ProductAgentRepo' -Value $ProductAgentRepo
$messageArgs = Add-OptionalValueArg -CurrentArgs $messageArgs -Name '-FlutterRepo' -Value $FlutterRepo
$messageArgs = Add-OptionalValueArg -CurrentArgs $messageArgs -Name '-GoPath' -Value $GoPath
if ($Apply) { $messageArgs += @('-Apply', '-IUnderstandThisRestartsMessageServer') }
if ($SkipMessageServerLocalVerifier) { $messageArgs += '-SkipLocalVerifier' }
if ($SkipFlutterVerifier) { $messageArgs += '-SkipFlutterVerifier' }

Invoke-ChildScript `
  -Label 'product-agent deploy gate' `
  -ScriptPath $productAgentDeploy `
  -Arguments $productArgs

Invoke-ChildScript `
  -Label 'message-server bridge deploy gate' `
  -ScriptPath $messageServerDeploy `
  -Arguments $messageArgs

if ($Apply) {
  $readinessArgs = $sharedArgs + @('-RequireConfigOnlySmoke', '-RequireLatestMessageServerBridge')
  Invoke-ChildScript `
    -Label 'combined post-deploy readiness gate' `
    -ScriptPath $readinessInspect `
    -Arguments $readinessArgs
} else {
  Write-Host ""
  Write-Host "Dry-run complete. The combined readiness gate is intentionally skipped until Apply mode."
}
