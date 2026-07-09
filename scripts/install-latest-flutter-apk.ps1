param(
  [string] $FlutterRepo,
  [string] $ApkPath,
  [string] $AdbPath,
  [string] $DeviceSerial,
  [switch] $ListDevicesOnly
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$WorkspaceRoot = Split-Path -Parent $RepoRoot

function Resolve-FlutterRepoPath {
  <#
    Function: Resolves the local Flutter repository used to build the Direxio App.
    Inputs:
      Candidate: Optional explicit Flutter repository path.
    Output:
      Absolute path to a repository containing pubspec.yaml.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when no Flutter repository can be found.
  #>
  param([string] $Candidate)

  $paths = @()
  if ($Candidate) { $paths += $Candidate }
  $paths += Join-Path $WorkspaceRoot 'direxio-flutter'

  foreach ($path in $paths) {
    if (-not $path) { continue }
    $resolved = [System.IO.Path]::GetFullPath($path)
    if ((Test-Path $resolved) -and (Test-Path (Join-Path $resolved 'pubspec.yaml'))) {
      return $resolved
    }
  }

  throw 'Could not resolve the Flutter repo. Pass -FlutterRepo <path-to-direxio-flutter>.'
}

function Resolve-ApkPath {
  <#
    Function: Finds the APK that should be installed for live App verification.
    Inputs:
      Candidate: Optional explicit APK path.
      FlutterRepoPath: Resolved Flutter repository path.
    Output:
      Absolute APK file path.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when the APK does not exist.
  #>
  param(
    [string] $Candidate,
    [string] $FlutterRepoPath
  )

  $paths = @()
  if ($Candidate) { $paths += $Candidate }
  $paths += Join-Path $FlutterRepoPath 'build\app\outputs\flutter-apk\app-debug.apk'

  foreach ($path in $paths) {
    if (-not $path) { continue }
    $resolved = [System.IO.Path]::GetFullPath($path)
    if (Test-Path $resolved) { return $resolved }
  }

  throw 'APK was not found. Build it first with: flutter build apk --debug --target-platform android-arm64'
}

function Resolve-AdbPath {
  <#
    Function: Finds adb.exe from an explicit path, PATH, Android SDK environment variables, or common SDK locations.
    Inputs:
      Candidate: Optional explicit adb.exe path.
    Output:
      Absolute adb.exe path.
    Side effects:
      Reads PATH and local filesystem metadata only.
    Errors:
      Throws when adb.exe cannot be found.
  #>
  param([string] $Candidate)

  $paths = @()
  if ($Candidate) { $paths += $Candidate }

  $cmd = Get-Command adb -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) { $paths += $cmd.Source }

  foreach ($envName in @('ANDROID_HOME', 'ANDROID_SDK_ROOT')) {
    $sdkRoot = [Environment]::GetEnvironmentVariable($envName)
    if ($sdkRoot) { $paths += Join-Path $sdkRoot 'platform-tools\adb.exe' }
  }

  $paths += @(
    'D:\AndroidSdk\platform-tools\adb.exe',
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
  )

  foreach ($path in $paths) {
    if (-not $path) { continue }
    $resolved = [System.IO.Path]::GetFullPath($path)
    if (Test-Path $resolved) { return $resolved }
  }

  throw 'adb.exe was not found. Install Android SDK platform-tools or pass -AdbPath <path-to-adb.exe>.'
}

function Get-AdbDevices {
  <#
    Function: Lists connected adb devices that are ready for install commands.
    Inputs:
      Adb: Absolute adb.exe path.
    Output:
      Objects with Serial and Description fields for each `device` state entry.
    Side effects:
      Starts/queries the local adb server.
    Errors:
      Throws when adb exits non-zero.
  #>
  param([string] $Adb)

  $lines = & $Adb devices -l
  if ($LASTEXITCODE -ne 0) {
    throw "adb devices failed with exit code $LASTEXITCODE."
  }

  $devices = @()
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line -match '^List of devices') { continue }
    if ($line -match '^(\S+)\s+device\s*(.*)$') {
      $devices += [pscustomobject]@{
        Serial      = $matches[1]
        Description = $matches[2].Trim()
      }
    }
  }
  return $devices
}

function Resolve-TargetDevice {
  <#
    Function: Chooses the adb target device for APK installation.
    Inputs:
      Devices: Ready adb device entries.
      Serial: Optional explicit device serial.
    Output:
      The selected adb device serial.
    Side effects:
      None.
    Errors:
      Throws when no devices are connected, the requested serial is missing, or multiple devices require disambiguation.
  #>
  param(
    [object[]] $Devices,
    [string] $Serial
  )

  if ($Serial) {
    $match = $Devices | Where-Object { $_.Serial -eq $Serial } | Select-Object -First 1
    if ($match) { return $match.Serial }
    throw "Requested adb device '$Serial' is not connected or not authorized."
  }

  if ($Devices.Count -eq 0) {
    throw 'No authorized Android device is connected. Connect a phone, enable USB debugging, accept the authorization prompt, then rerun this script.'
  }

  if ($Devices.Count -gt 1) {
    $serials = ($Devices | ForEach-Object { $_.Serial }) -join ', '
    throw "Multiple Android devices are connected: $serials. Re-run with -DeviceSerial <serial>."
  }

  return $Devices[0].Serial
}

$flutterPath = Resolve-FlutterRepoPath -Candidate $FlutterRepo
$resolvedApk = Resolve-ApkPath -Candidate $ApkPath -FlutterRepoPath $flutterPath
$resolvedAdb = Resolve-AdbPath -Candidate $AdbPath
$devices = @(Get-AdbDevices -Adb $resolvedAdb)

Write-Host "Flutter repo: $flutterPath"
Write-Host "APK: $resolvedApk"
Write-Host "adb: $resolvedAdb"
Write-Host "Connected authorized Android devices: $($devices.Count)"
foreach ($device in $devices) {
  Write-Host "- $($device.Serial) $($device.Description)"
}

if ($ListDevicesOnly) {
  exit 0
}

$targetSerial = Resolve-TargetDevice -Devices $devices -Serial $DeviceSerial
Write-Host "Installing APK on $targetSerial..."
& $resolvedAdb -s $targetSerial install -r $resolvedApk
if ($LASTEXITCODE -ne 0) {
  throw "adb install failed with exit code $LASTEXITCODE."
}

Write-Host "APK install completed."
