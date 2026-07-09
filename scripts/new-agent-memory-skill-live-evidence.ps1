param(
  [string] $OutputPath,
  [string] $TemplatePath = 'docs\superpowers\plans\2026-07-08-agent-memory-prompt-skill-live-app-evidence-template.md',
  [string] $NodeDomain = 'codex1.p2pagent.im',
  [string] $OwnerAccount,
  [string] $AppBuildVersion,
  [string] $AgentRoomId,
  [string] $EvidenceFolder,
  [switch] $Force
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

function New-DefaultEvidencePath {
  <#
    Function: Builds the default timestamped evidence file path.
    Inputs:
      None.
    Output:
      Absolute path under docs/superpowers/plans/evidence with a timestamped file name.
    Side effects:
      None.
    Errors:
      None.
  #>
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  return Join-Path $RepoRoot "docs\superpowers\plans\evidence\live-app-agent-memory-skill-evidence-$stamp.md"
}

function Assert-TemplateExists {
  <#
    Function: Confirms that the live App evidence template exists before copying it.
    Inputs:
      Path: Absolute template file path.
    Output:
      None.
    Side effects:
      Reads local filesystem metadata only.
    Errors:
      Throws when the template file is missing.
  #>
  param([string] $Path)

  if (-not (Test-Path $Path -PathType Leaf)) {
    throw "Evidence template was not found at $Path."
  }
}

function Assert-OutputCanBeWritten {
  <#
    Function: Ensures the output path can be written without accidentally overwriting evidence.
    Inputs:
      Path: Absolute output file path.
      ForceOverwrite: Whether the operator explicitly allowed overwriting an existing file.
    Output:
      None.
    Side effects:
      Creates the parent directory when needed.
    Errors:
      Throws when the output exists and ForceOverwrite is not set.
  #>
  param(
    [string] $Path,
    [bool] $ForceOverwrite
  )

  if ((Test-Path $Path -PathType Leaf) -and -not $ForceOverwrite) {
    throw "Refusing to overwrite existing evidence file at $Path. Pass -Force or choose a new -OutputPath."
  }

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

function Set-MarkdownBulletValue {
  <#
    Function: Replaces one markdown bullet value while preserving the bullet label.
    Inputs:
      Content: Full markdown template text.
      Label: Bullet label before the colon.
      Value: Value to place after the colon; empty values leave the content unchanged.
    Output:
      Updated markdown text.
    Side effects:
      None.
    Errors:
      None; missing labels leave the content unchanged.
  #>
  param(
    [string] $Content,
    [string] $Label,
    [string] $Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Content
  }

  $escapedLabel = [regex]::Escape($Label)
  $escapedValue = $Value.Replace('$', '$$')
  return [regex]::Replace(
    $Content,
    "(?m)^([ \t]*-[ \t]*$escapedLabel[ \t]*:).*$",
    "`$1 $escapedValue"
  )
}

function Build-EvidenceContent {
  <#
    Function: Builds a new live App evidence markdown document from the template.
    Inputs:
      TemplateContent: Raw markdown template text.
      NodeDomain: Node or domain being tested.
      OwnerAccount: Optional owner account identifier.
      AppBuildVersion: Optional App build or version value.
      AgentRoomId: Optional Agent room id.
      EvidenceFolder: Optional local folder for screenshots or recordings.
    Output:
      Markdown content ready to write.
    Side effects:
      None.
    Errors:
      None.
  #>
  param(
    [string] $TemplateContent,
    [string] $NodeDomain,
    [string] $OwnerAccount,
    [string] $AppBuildVersion,
    [string] $AgentRoomId,
    [string] $EvidenceFolder
  )

  $content = $TemplateContent
  $content = Set-MarkdownBulletValue -Content $content -Label 'Date/time' -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))
  $content = Set-MarkdownBulletValue -Content $content -Label 'Node/domain' -Value $NodeDomain
  $content = Set-MarkdownBulletValue -Content $content -Label 'Owner account' -Value $OwnerAccount
  $content = Set-MarkdownBulletValue -Content $content -Label 'App build/version' -Value $AppBuildVersion
  $content = Set-MarkdownBulletValue -Content $content -Label 'Agent room id' -Value $AgentRoomId
  $content = Set-MarkdownBulletValue -Content $content -Label 'Evidence screenshots or recording folder' -Value $EvidenceFolder
  return $content
}

$resolvedTemplate = Resolve-RepoPath -Path $TemplatePath
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $resolvedOutput = New-DefaultEvidencePath
} else {
  $resolvedOutput = Resolve-RepoPath -Path $OutputPath
}

Assert-TemplateExists -Path $resolvedTemplate
Assert-OutputCanBeWritten -Path $resolvedOutput -ForceOverwrite ([bool]$Force)

$templateContent = Get-Content -Raw $resolvedTemplate
$content = Build-EvidenceContent `
  -TemplateContent $templateContent `
  -NodeDomain $NodeDomain `
  -OwnerAccount $OwnerAccount `
  -AppBuildVersion $AppBuildVersion `
  -AgentRoomId $AgentRoomId `
  -EvidenceFolder $EvidenceFolder

Set-Content -Path $resolvedOutput -Value $content -Encoding utf8

Write-Host "Created live App evidence file: $resolvedOutput"
Write-Host ""
Write-Host "Fill the Prompt Skill, Memory, and Card Rendering sections, then validate it with:"
Write-Host "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-agent-memory-skill-live-evidence.ps1 -LiveAppEvidencePath `"$resolvedOutput`""
