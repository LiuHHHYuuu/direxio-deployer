param(
  [string] $MessageServerRepo,
  [string] $NodeDomain = 'codex1.p2pagent.im',
  [string] $SshUser = 'ubuntu',
  [string] $KeyFile,
  [string] $RemoteDir = '/var/direxio-message-server',
  [string] $ProductAgentRepo,
  [string] $FlutterRepo,
  [string] $GoPath,
  [switch] $Apply,
  [switch] $IUnderstandThisRestartsMessageServer,
  [switch] $SkipLocalVerifier,
  [switch] $SkipFlutterVerifier
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

function Resolve-MessageServerRepo {
  <#
    Function: Finds the local dirextalk-message-server repository used to build the bridge binary.
    Inputs:
      Candidate: Optional path passed by the caller.
    Output:
      Absolute repository path.
    Side effects:
      Reads the local filesystem only.
    Errors:
      Throws when the repository or expected Go entrypoint is missing.
  #>
  param([string] $Candidate)

  $paths = @()
  if ($Candidate) {
    $paths += $Candidate
  }
  $paths += (Join-Path (Split-Path -Parent $RepoRoot) 'dirextalk-message-server')

  foreach ($path in $paths) {
    if (-not $path) { continue }
    $resolved = [System.IO.Path]::GetFullPath($path)
    $entrypoint = Join-Path $resolved 'cmd\dirextalk-message-server'
    if ((Test-Path $resolved) -and (Test-Path $entrypoint)) {
      return $resolved
    }
  }

  throw "Could not find dirextalk-message-server. Pass -MessageServerRepo <path>."
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
    if (Test-Path $resolved) {
      return $resolved
    }
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
    Function: Finds the Go executable used for local checks and Linux binary builds.
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
    Function: Verifies that a required executable is available before deployment starts.
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
    Function: Runs the cross-repo local verifier before a remote restart.
    Inputs:
      MessageServerRepoPath: Local message-server repository path.
      ProductAgentRepoPath: Optional product-agent repository path.
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
    [string] $MessageServerRepoPath,
    [string] $ProductAgentRepoPath,
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
    '-MessageServerRepo', $MessageServerRepoPath,
    '-GoPath', $GoCommand
  )
  if ($ProductAgentRepoPath) {
    $verifierArgs += @('-ProductAgentRepo', $ProductAgentRepoPath)
  }
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

function Build-LinuxMessageServer {
  <#
    Function: Builds a Linux amd64 dirextalk-message-server binary from the local message-server repo.
    Inputs:
      SourceRepo: Local message-server repository path.
      GoCommand: Resolved Go executable.
    Output:
      Path to the temporary Linux binary.
    Side effects:
      Runs `go build` and writes a temporary binary under the OS temp directory.
    Errors:
      Propagates Go build failures.
  #>
  param(
    [string] $SourceRepo,
    [string] $GoCommand
  )

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outDir = Join-Path ([System.IO.Path]::GetTempPath()) "direxio-message-server-bridge-$stamp"
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $binary = Join-Path $outDir 'direxio-message-server'

  Push-Location $SourceRepo
  try {
    $oldGoos = $env:GOOS
    $oldGoarch = $env:GOARCH
    $oldCgo = $env:CGO_ENABLED
    $env:GOOS = 'linux'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    & $GoCommand build -o $binary ./cmd/dirextalk-message-server
    if ($LASTEXITCODE -ne 0) {
      throw "go build failed with exit code $LASTEXITCODE."
    }
  } finally {
    $env:GOOS = $oldGoos
    $env:GOARCH = $oldGoarch
    $env:CGO_ENABLED = $oldCgo
    Pop-Location
  }

  return $binary
}

function New-RemoteDeployScript {
  <#
    Function: Creates the shell script that runs inside the remote node.
    Inputs:
      RemoteBinary: Uploaded temporary binary path on the node.
      RemoteDirPath: Docker compose directory on the node.
      BackupPath: Backup path for the current container binary.
    Output:
      Shell script text.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string] $RemoteBinary,
    [string] $RemoteDirPath,
    [string] $BackupPath
  )

  return @"
#!/usr/bin/env bash
set -euo pipefail

REMOTE_DIR='$RemoteDirPath'
REMOTE_BINARY='$RemoteBinary'
BACKUP_PATH='$BackupPath'

cd "`$REMOTE_DIR"

rollback_message_server() {
  echo "Rolling back message-server binary." >&2
  container="`$(sudo docker compose ps -q message-server)"
  sudo docker cp "`$BACKUP_PATH" "`$container:/usr/bin/direxio-message-server"
  sudo docker compose exec -T message-server chmod 0755 /usr/bin/direxio-message-server
  sudo docker compose restart message-server
}

verify_product_agent_bridge() {
  if ! sudo docker compose exec -T message-server sh -lc "grep -a -q '/v1/message-server/new-message' /usr/bin/direxio-message-server && grep -a -q 'io.direxio.agent_action_result' /usr/bin/direxio-message-server && grep -a -q 'agent.memory.save' /usr/bin/direxio-message-server"; then
    echo "message-server binary does not contain the product-agent bridge markers" >&2
    return 1
  fi
  if ! sudo docker compose exec -T message-server sh -lc "env | grep -q '^DIREXIO_PRODUCT_AGENT_URL=.'"; then
    echo "message-server container is missing DIREXIO_PRODUCT_AGENT_URL" >&2
    return 1
  fi
  echo "message-server product-agent bridge markers are present"
}

container="`$(sudo docker compose ps -q message-server)"
if [ -z "`$container" ]; then
  echo "message-server container was not found" >&2
  exit 1
fi

sudo docker cp "`$container:/usr/bin/direxio-message-server" "`$BACKUP_PATH"
sudo docker cp "`$REMOTE_BINARY" "`$container:/usr/bin/direxio-message-server"
sudo docker compose exec -T message-server chmod 0755 /usr/bin/direxio-message-server
sudo docker compose restart message-server

for attempt in 1 2 3 4 5 6; do
  if sudo docker compose exec -T message-server wget -q -O- http://127.0.0.1:8008/_p2p/health >/tmp/direxio-message-server-health.out 2>/tmp/direxio-message-server-health.err; then
    cat /tmp/direxio-message-server-health.out
    if verify_product_agent_bridge; then
      exit 0
    fi
    rollback_message_server
    exit 1
  fi
  sleep 5
done

echo "Health check failed after restart. Rolling back message-server binary." >&2
rollback_message_server
exit 1
"@
}

function Invoke-RemoteDeploy {
  <#
    Function: Uploads the new binary and runs the guarded remote deployment script.
    Inputs:
      Binary: Local Linux binary path.
      Target: SSH target in user@host form.
      Pem: SSH private key path.
      RemoteDirPath: Remote compose directory.
    Output:
      None.
    Side effects:
      Copies files to the remote node, backs up the old binary, restarts message-server, and rolls back on failed health check.
    Errors:
      Throws when scp, ssh, restart, health check, or rollback command fails.
  #>
  param(
    [string] $Binary,
    [string] $Target,
    [string] $Pem,
    [string] $RemoteDirPath
  )

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $remoteBinary = "/tmp/direxio-message-server.bridge.$stamp"
  $remoteScriptPath = "/tmp/direxio-message-server-bridge-deploy.$stamp.sh"
  $backupPath = "/tmp/direxio-message-server.backup.$stamp"
  $localScript = Join-Path ([System.IO.Path]::GetTempPath()) "direxio-message-server-bridge-deploy-$stamp.sh"

  $remoteScript = New-RemoteDeployScript -RemoteBinary $remoteBinary -RemoteDirPath $RemoteDirPath -BackupPath $backupPath
  Set-Content -Path $localScript -Value $remoteScript -Encoding ascii

  & scp -i $Pem -o StrictHostKeyChecking=accept-new $Binary "${Target}:$remoteBinary"
  if ($LASTEXITCODE -ne 0) { throw "scp binary failed with exit code $LASTEXITCODE." }

  & scp -i $Pem -o StrictHostKeyChecking=accept-new $localScript "${Target}:$remoteScriptPath"
  if ($LASTEXITCODE -ne 0) { throw "scp deploy script failed with exit code $LASTEXITCODE." }

  & ssh -i $Pem -o StrictHostKeyChecking=accept-new $Target "chmod +x $remoteScriptPath && bash $remoteScriptPath"
  if ($LASTEXITCODE -ne 0) { throw "remote deploy failed with exit code $LASTEXITCODE." }
}

function Invoke-PostDeployReadinessInspection {
  <#
    Function: Runs the read-only readiness inspection after a successful message-server update.
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
      Throws when the deployed message-server does not expose the latest product-agent bridge markers.
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
    -RequireLatestMessageServerBridge
  if ($LASTEXITCODE -ne 0) {
    throw "post-deploy message-server readiness inspection failed with exit code $LASTEXITCODE."
  }
}

$messageServerRepoPath = Resolve-MessageServerRepo -Candidate $MessageServerRepo
$keyPath = Resolve-NodeKeyFile -Candidate $KeyFile -Domain $NodeDomain
$sshTarget = "$SshUser@$NodeDomain"

Write-Host "Message-server repo: $messageServerRepoPath"
Write-Host "Node: $sshTarget"
Write-Host "Remote compose dir: $RemoteDir"
Write-Host "SSH key: $keyPath"

if (-not $Apply) {
  Write-Host ""
  Write-Host "Dry-run only. No build, upload, or restart was performed."
  Write-Host "Apply mode runs the local verifier first unless -SkipLocalVerifier is supplied."
  Write-Host "Apply mode also runs the read-only message-server bridge readiness gate after restart."
  Write-Host "To deploy, run this script with -Apply -IUnderstandThisRestartsMessageServer."
  exit 0
}

if (-not $IUnderstandThisRestartsMessageServer) {
  throw "Refusing to deploy. Re-run with -IUnderstandThisRestartsMessageServer to confirm the message-server restart."
}

$goCommand = Resolve-GoCommand -Candidate $GoPath
Assert-CommandAvailable -Name 'scp'
Assert-CommandAvailable -Name 'ssh'

if (-not $SkipLocalVerifier) {
  Invoke-LocalVerifier `
    -MessageServerRepoPath $messageServerRepoPath `
    -ProductAgentRepoPath $ProductAgentRepo `
    -FlutterRepoPath $FlutterRepo `
    -GoCommand $goCommand `
    -SkipFlutter ([bool]$SkipFlutterVerifier)
}

$linuxBinary = Build-LinuxMessageServer -SourceRepo $messageServerRepoPath -GoCommand $goCommand
Write-Host "Built Linux binary: $linuxBinary"

Invoke-RemoteDeploy -Binary $linuxBinary -Target $sshTarget -Pem $keyPath -RemoteDirPath $RemoteDir

Invoke-PostDeployReadinessInspection `
  -Domain $NodeDomain `
  -User $SshUser `
  -Pem $keyPath `
  -RemoteDirPath $RemoteDir

Write-Host "message-server bridge deployment completed."
