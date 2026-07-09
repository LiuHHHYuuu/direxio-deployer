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
  [switch] $SkipLocalVerifier,
  [switch] $SkipFlutterVerifier,
  [switch] $SkipContainerSmoke
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$WorkspaceRoot = Split-Path -Parent $RepoRoot

function Resolve-RepoPath {
  <#
    Function: Resolves a local repository path used by this deployment script.
    Inputs:
      Candidate: Optional caller-provided path.
      DefaultPath: Expected path when working in the shared IM2 workspace.
      RequiredChild: File or directory that must exist in the repository.
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

function Resolve-NodeKeyFile {
  <#
    Function: Finds the SSH private key for the target Direxio node.
    Inputs:
      Candidate: Optional explicit PEM path.
      Domain: Node domain, used to inspect ~/.direxio/nodes/<domain>.
    Output:
      Absolute PEM path.
    Side effects:
      Reads local node state files only.
    Errors:
      Throws when no PEM can be found.
  #>
  param(
    [string] $Candidate,
    [string] $Domain
  )

  if ($Candidate) {
    $resolved = [System.IO.Path]::GetFullPath($Candidate)
    if (Test-Path $resolved) { return $resolved }
    throw "SSH key was not found at $resolved."
  }

  $nodeDir = Join-Path $env:USERPROFILE ".direxio\nodes\$Domain"
  if (-not (Test-Path $nodeDir)) {
    throw "Node state was not found at $nodeDir. Pass -KeyFile <path>."
  }

  $pem = Get-ChildItem $nodeDir -Filter '*.pem' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $pem) {
    throw "No PEM file was found under $nodeDir. Pass -KeyFile <path>."
  }

  return $pem.FullName
}

function Resolve-GoCommand {
  <#
    Function: Finds the Go executable used by the local cross-repo verifier.
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

function Assert-CommandAvailable {
  <#
    Function: Verifies that a required executable is available before Apply mode starts.
    Inputs:
      Name: Command name to resolve from PATH.
    Output:
      None.
    Side effects:
      Reads PATH through Get-Command.
    Errors:
      Throws when the command is unavailable.
  #>
  param([string] $Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Invoke-LocalVerifier {
  <#
    Function: Runs the cross-repo memory, Prompt Skill, bridge, and Flutter verifier.
    Inputs:
      ProductAgentRepoPath: Local product-agent repository path.
      MessageServerRepoPath: Local message-server repository path.
      FlutterRepoPath: Optional Flutter repository path.
      GoCommand: Resolved Go executable.
      SkipFlutter: Whether to skip Flutter UI checks.
    Output:
      None.
    Side effects:
      Runs local tests and builds; does not contact or restart the remote node.
    Errors:
      Throws when the verifier script fails.
  #>
  param(
    [string] $ProductAgentRepoPath,
    [string] $MessageServerRepoPath,
    [string] $FlutterRepoPath,
    [string] $GoCommand,
    [bool] $SkipFlutter
  )

  $verifier = Join-Path $ScriptDir 'verify-agent-memory-skill-loop.ps1'
  if (-not (Test-Path $verifier)) {
    throw "Local verifier was not found at $verifier."
  }

  $verifierArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $verifier,
    '-ProductAgentRepo', $ProductAgentRepoPath,
    '-MessageServerRepo', $MessageServerRepoPath,
    '-GoPath', $GoCommand
  )
  if ($FlutterRepoPath) {
    $verifierArgs += @('-FlutterRepo', $FlutterRepoPath)
  }
  if ($SkipFlutter) {
    $verifierArgs += '-SkipFlutter'
  }

  & powershell @verifierArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Local verifier failed with exit code $LASTEXITCODE."
  }
}

function Build-And-SmokeProductAgentImage {
  <#
    Function: Builds the product-agent Docker image and proves it with the container smoke.
    Inputs:
      ProductAgentRepoPath: Local product-agent repository path.
      Tag: Docker image tag to build and deploy.
      SkipSmoke: Whether to skip the container-level smoke.
    Output:
      None.
    Side effects:
      Builds a local Docker image; smoke creates and removes temporary Docker resources.
    Errors:
      Throws when Docker build or smoke fails.
  #>
  param(
    [string] $ProductAgentRepoPath,
    [string] $Tag,
    [bool] $SkipSmoke
  )

  Push-Location $ProductAgentRepoPath
  try {
    & docker build -t $Tag .
    if ($LASTEXITCODE -ne 0) {
      throw "docker build failed with exit code $LASTEXITCODE."
    }

    if (-not $SkipSmoke) {
      $oldImage = $env:DIREXIO_PRODUCT_AGENT_SMOKE_IMAGE
      $oldSkipBuild = $env:DIREXIO_PRODUCT_AGENT_SMOKE_SKIP_BUILD
      try {
        $env:DIREXIO_PRODUCT_AGENT_SMOKE_IMAGE = $Tag
        $env:DIREXIO_PRODUCT_AGENT_SMOKE_SKIP_BUILD = '1'
        & npm run smoke:container
        if ($LASTEXITCODE -ne 0) {
          throw "product-agent container smoke failed with exit code $LASTEXITCODE."
        }
      } finally {
        $env:DIREXIO_PRODUCT_AGENT_SMOKE_IMAGE = $oldImage
        $env:DIREXIO_PRODUCT_AGENT_SMOKE_SKIP_BUILD = $oldSkipBuild
      }
    }
  } finally {
    Pop-Location
  }
}

function Save-DockerImageArchive {
  <#
    Function: Saves a Docker image to a temporary tar archive for SSH upload.
    Inputs:
      Tag: Local Docker image tag.
    Output:
      Absolute path to the temporary Docker archive.
    Side effects:
      Writes a tar file under the OS temp directory.
    Errors:
      Throws when docker save fails.
  #>
  param([string] $Tag)

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $archive = Join-Path ([System.IO.Path]::GetTempPath()) "direxio-product-agent-$stamp.tar"
  & docker save -o $archive $Tag
  if ($LASTEXITCODE -ne 0) {
    throw "docker save failed with exit code $LASTEXITCODE."
  }
  return $archive
}

function Shell-SingleQuote {
  <#
    Function: Quotes a value for safe inclusion in the generated remote shell script.
    Inputs:
      Value: String value to quote.
    Output:
      Single-quoted shell literal.
    Side effects:
      None.
    Errors:
      None.
  #>
  param([string] $Value)

  return "'" + ($Value -replace "'", "'\''") + "'"
}

function New-RemoteDeployScript {
  <#
    Function: Creates the shell script that loads and restarts product-agent on the remote node.
    Inputs:
      RemoteDirPath: Docker compose directory on the node.
      ImageTagValue: Docker tag to set in .env.
      RemoteArchive: Uploaded Docker image archive.
      RemoteSmokeScript: Uploaded remote smoke script path.
      BackupPath: Backup path for the previous .env.
    Output:
      Shell script text.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string] $RemoteDirPath,
    [string] $ImageTagValue,
    [string] $RemoteArchive,
    [string] $RemoteSmokeScript,
    [string] $BackupPath
  )

  $quotedRemoteDir = Shell-SingleQuote $RemoteDirPath
  $quotedImageTag = Shell-SingleQuote $ImageTagValue
  $quotedArchive = Shell-SingleQuote $RemoteArchive
  $quotedSmoke = Shell-SingleQuote $RemoteSmokeScript
  $quotedBackup = Shell-SingleQuote $BackupPath

  return @"
#!/usr/bin/env bash
set -euo pipefail

REMOTE_DIR=$quotedRemoteDir
IMAGE_TAG=$quotedImageTag
IMAGE_ARCHIVE=$quotedArchive
SMOKE_SCRIPT=$quotedSmoke
BACKUP_PATH=$quotedBackup
COMPOSE_BACKUP_PATH="`$BACKUP_PATH.compose.yml"

cd "`$REMOTE_DIR"

ENV_WORK="`$(mktemp /tmp/direxio-product-agent.env.work.XXXXXX)"
ENV_OWNER_GROUP="root:root"
ENV_MODE="600"
cleanup() {
  rm -f "`$ENV_WORK"
}
trap cleanup EXIT

if [ -f .env ]; then
  ENV_OWNER_GROUP="`$(sudo stat -c '%u:%g' .env)"
  ENV_MODE="`$(sudo stat -c '%a' .env)"
  sudo cp .env "`$BACKUP_PATH"
  sudo cat .env > "`$ENV_WORK"
else
  : > "`$ENV_WORK"
  sudo cp "`$ENV_WORK" "`$BACKUP_PATH"
fi

set_env() {
  local key="`$1"
  local value="`$2"
  if grep -q "^`$key=" "`$ENV_WORK"; then
    sed -i "s|^`$key=.*|`$key=`$value|" "`$ENV_WORK"
  else
    printf '%s=%s\n' "`$key" "`$value" >> "`$ENV_WORK"
  fi
}

install_env() {
  sudo install -m "`$ENV_MODE" -o "`$`{ENV_OWNER_GROUP%%:*`}" -g "`$`{ENV_OWNER_GROUP##*:`}" "`$ENV_WORK" .env
}

ensure_compose_env() {
  if [ ! -f docker-compose.yml ]; then
    echo "docker-compose.yml not found in `$REMOTE_DIR" >&2
    exit 1
  fi
  sudo cp docker-compose.yml "`$COMPOSE_BACKUP_PATH"
  sudo python3 - <<'PY'
from pathlib import Path

p = Path("docker-compose.yml")
s = p.read_text()
needle = "      DIREXIO_AGENT_DATA_DIR: /var/lib/direxio-product-agent\n"
if needle not in s:
    raise SystemExit("product-agent data dir line not found in docker-compose.yml")
if "DIREXIO_AGENT_RUNTIME:" not in s:
    s = s.replace(
        needle,
        needle + "      DIREXIO_AGENT_RUNTIME: `$`{DIREXIO_AGENT_RUNTIME:-langchain`}\n",
        1
    )
if "DIREXIO_AGENT_WEB_SEARCH:" not in s:
    s = s.replace(
        "      DIREXIO_AGENT_RUNTIME: `$`{DIREXIO_AGENT_RUNTIME:-langchain`}\n",
        "      DIREXIO_AGENT_RUNTIME: `$`{DIREXIO_AGENT_RUNTIME:-langchain`}\n"
        "      DIREXIO_AGENT_WEB_SEARCH: `$`{DIREXIO_AGENT_WEB_SEARCH:-1`}\n",
        1
    )
p.write_text(s)
PY
}

previous_image="`$(grep '^DIREXIO_PRODUCT_AGENT_IMAGE=' "`$ENV_WORK" | tail -n1 | cut -d= -f2- || true)"

sudo docker load -i "`$IMAGE_ARCHIVE"
set_env DIREXIO_PRODUCT_AGENT_IMAGE "`$IMAGE_TAG"
set_env DIREXIO_PRODUCT_AGENT_URL "http://product-agent:8797"
set_env DIREXIO_AGENT_RUNTIME "langchain"
set_env DIREXIO_AGENT_WEB_SEARCH "1"
set_env COMPOSE_PROFILES "product-agent"
install_env
ensure_compose_env

sudo docker compose --env-file .env up -d product-agent

if ! DIREXIO_PRODUCT_AGENT_SMOKE_RESTART=1 bash "`$SMOKE_SCRIPT"; then
  echo "product-agent remote smoke failed; attempting image rollback" >&2
  if [ -n "`$previous_image" ]; then
    set_env DIREXIO_PRODUCT_AGENT_IMAGE "`$previous_image"
    install_env
    if [ -f "`$COMPOSE_BACKUP_PATH" ]; then sudo cp "`$COMPOSE_BACKUP_PATH" docker-compose.yml; fi
    sudo docker compose --env-file .env up -d product-agent
  else
    sudo cp "`$BACKUP_PATH" .env
    if [ -f "`$COMPOSE_BACKUP_PATH" ]; then sudo cp "`$COMPOSE_BACKUP_PATH" docker-compose.yml; fi
    sudo docker compose --env-file .env up -d product-agent || true
  fi
  exit 1
fi

echo "product-agent deploy and remote smoke passed"
"@
}

function Invoke-RemoteDeploy {
  <#
    Function: Uploads the Docker image archive and runs the guarded remote product-agent update.
    Inputs:
      Archive: Local Docker image archive path.
      SmokeScript: Local remote smoke script path.
      Target: SSH target in user@host form.
      Pem: SSH private key path.
      RemoteDirPath: Remote compose directory.
      Tag: Docker image tag to activate.
    Output:
      None.
    Side effects:
      Uploads files, loads Docker image, updates .env, restarts product-agent, and rolls back image selection on smoke failure.
    Errors:
      Throws when upload, remote script, compose, or smoke fails.
  #>
  param(
    [string] $Archive,
    [string] $SmokeScript,
    [string] $Target,
    [string] $Pem,
    [string] $RemoteDirPath,
    [string] $Tag
  )

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $remoteArchive = "/tmp/direxio-product-agent.$stamp.tar"
  $remoteSmoke = "/tmp/direxio-product-agent-remote-smoke.$stamp.sh"
  $remoteScriptPath = "/tmp/direxio-product-agent-deploy.$stamp.sh"
  $backupPath = "/tmp/direxio-product-agent.env.backup.$stamp"
  $localScript = Join-Path ([System.IO.Path]::GetTempPath()) "direxio-product-agent-deploy-$stamp.sh"

  $remoteScript = New-RemoteDeployScript `
    -RemoteDirPath $RemoteDirPath `
    -ImageTagValue $Tag `
    -RemoteArchive $remoteArchive `
    -RemoteSmokeScript $remoteSmoke `
    -BackupPath $backupPath
  Set-Content -Path $localScript -Value $remoteScript -Encoding ascii

  & scp -i $Pem -o StrictHostKeyChecking=accept-new $Archive "${Target}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "scp product-agent image archive failed with exit code $LASTEXITCODE." }

  & scp -i $Pem -o StrictHostKeyChecking=accept-new $SmokeScript "${Target}:$remoteSmoke"
  if ($LASTEXITCODE -ne 0) { throw "scp remote smoke script failed with exit code $LASTEXITCODE." }

  & scp -i $Pem -o StrictHostKeyChecking=accept-new $localScript "${Target}:$remoteScriptPath"
  if ($LASTEXITCODE -ne 0) { throw "scp deploy script failed with exit code $LASTEXITCODE." }

  & ssh -i $Pem -o StrictHostKeyChecking=accept-new $Target "chmod +x $remoteSmoke $remoteScriptPath && bash $remoteScriptPath"
  if ($LASTEXITCODE -ne 0) { throw "remote product-agent deploy failed with exit code $LASTEXITCODE." }
}

function Invoke-PostDeployReadinessInspection {
  <#
    Function: Runs the read-only readiness inspection after a successful product-agent update.
    Inputs:
      Domain: Node domain to inspect.
      User: SSH user.
      Pem: SSH private key path.
      RemoteDirPath: Remote compose directory.
    Output:
      None.
    Side effects:
      Performs read-only SSH checks against the deployed node.
    Errors:
      Throws when the deployed product-agent does not expose the required latest smoke marker.
  #>
  param(
    [string] $Domain,
    [string] $User,
    [string] $Pem,
    [string] $RemoteDirPath
  )

  $readinessScript = Join-Path $ScriptDir 'inspect-agent-stack-readiness.ps1'
  if (-not (Test-Path $readinessScript)) {
    throw "Readiness inspection script was not found at $readinessScript."
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -File $readinessScript `
    -NodeDomain $Domain `
    -SshUser $User `
    -KeyFile $Pem `
    -RemoteDir $RemoteDirPath `
    -RequireConfigOnlySmoke
  if ($LASTEXITCODE -ne 0) {
    throw "post-deploy readiness inspection failed with exit code $LASTEXITCODE."
  }
}

$productAgentRepoPath = Resolve-RepoPath `
  -Candidate $ProductAgentRepo `
  -DefaultPath (Join-Path $RepoRoot 'product-agent') `
  -RequiredChild 'Dockerfile'
$messageServerRepoPath = Resolve-RepoPath `
  -Candidate $MessageServerRepo `
  -DefaultPath (Join-Path $WorkspaceRoot 'dirextalk-message-server') `
  -RequiredChild 'cmd\dirextalk-message-server'
$flutterRepoPath = Resolve-RepoPath `
  -Candidate $FlutterRepo `
  -DefaultPath (Join-Path $WorkspaceRoot 'direxio-flutter') `
  -RequiredChild 'pubspec.yaml'
$keyPath = Resolve-NodeKeyFile -Candidate $KeyFile -Domain $NodeDomain
$sshTarget = "$SshUser@$NodeDomain"
$imageTagValue = if ($ImageTag) {
  $ImageTag
} else {
  "direxio/product-agent:agent-loop-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}
$remoteSmokePath = Join-Path $productAgentRepoPath 'scripts\remote-smoke.sh'
if (-not (Test-Path $remoteSmokePath)) {
  throw "Remote smoke script was not found at $remoteSmokePath."
}

Write-Host "Product-agent repo: $productAgentRepoPath"
Write-Host "Message-server repo: $messageServerRepoPath"
Write-Host "Flutter repo: $flutterRepoPath"
Write-Host "Node: $sshTarget"
Write-Host "Remote compose dir: $RemoteDir"
Write-Host "Image tag: $imageTagValue"
Write-Host "SSH key: $keyPath"

if (-not $Apply) {
  Write-Host ""
  Write-Host "Dry-run only. No image build, upload, container restart, or remote smoke was performed."
  Write-Host "Apply mode runs the local verifier and container smoke first unless explicitly skipped."
  Write-Host "To deploy, run this script with -Apply -IUnderstandThisRestartsProductAgent."
  exit 0
}

if (-not $IUnderstandThisRestartsProductAgent) {
  throw "Refusing to deploy. Re-run with -IUnderstandThisRestartsProductAgent to confirm the product-agent restart."
}

Assert-CommandAvailable -Name 'docker'
Assert-CommandAvailable -Name 'npm'
Assert-CommandAvailable -Name 'scp'
Assert-CommandAvailable -Name 'ssh'
$goCommand = Resolve-GoCommand -Candidate $GoPath

if (-not $SkipLocalVerifier) {
  Invoke-LocalVerifier `
    -ProductAgentRepoPath $productAgentRepoPath `
    -MessageServerRepoPath $messageServerRepoPath `
    -FlutterRepoPath $flutterRepoPath `
    -GoCommand $goCommand `
    -SkipFlutter ([bool]$SkipFlutterVerifier)
}

Build-And-SmokeProductAgentImage `
  -ProductAgentRepoPath $productAgentRepoPath `
  -Tag $imageTagValue `
  -SkipSmoke ([bool]$SkipContainerSmoke)

$archivePath = Save-DockerImageArchive -Tag $imageTagValue
try {
  Invoke-RemoteDeploy `
    -Archive $archivePath `
    -SmokeScript $remoteSmokePath `
    -Target $sshTarget `
    -Pem $keyPath `
    -RemoteDirPath $RemoteDir `
    -Tag $imageTagValue
} finally {
  if (Test-Path $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
}

Invoke-PostDeployReadinessInspection `
  -Domain $NodeDomain `
  -User $SshUser `
  -Pem $keyPath `
  -RemoteDirPath $RemoteDir

Write-Host "product-agent deployment completed."
