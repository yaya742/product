#Requires -Version 5.1

param()

$ErrorActionPreference = 'Stop'
# Keep this script ASCII-compatible because Windows PowerShell 5.1 reads
# UTF-8-without-BOM source files using the active legacy code page.
$productDirectory = -join ([char]0x5728, [char]0x573A)
$secretFile = Join-Path $env:LOCALAPPDATA "$productDirectory\secrets\deepseek-api-key.dpapi"
# npm invokes package scripts through cmd.exe. On this host that can leave the
# security module only discoverable by name but not loadable; import the copy
# belonging to the active Windows PowerShell explicitly.
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $securityModule -ErrorAction Stop
$Action = if ($args.Count -gt 0) { [string]$args[0] } else { 'status' }
$Command = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }
if ($Action -notin @('status', 'run', 'run-live')) {
  Write-Error 'The first argument must be status, run, or run-live.'
  exit 2
}

function Read-ProjectDeepSeekKey {
  if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
    throw 'The project DeepSeek credential has not been saved for this Windows user.'
  }

  $serialized = (Get-Content -LiteralPath $secretFile -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($serialized)) {
    throw 'The project DeepSeek credential file is empty.'
  }

  $secure = $serialized | ConvertTo-SecureString
  try {
    $credential = [System.Management.Automation.PSCredential]::new('deepseek', $secure)
    $plain = $credential.GetNetworkCredential().Password
    if (
      [string]::IsNullOrWhiteSpace($plain) -or
      $plain.Length -lt 8 -or
      $plain.Length -gt 512 -or
      $plain -match '\s'
    ) {
      throw 'The decrypted project DeepSeek credential is not plausible.'
    }
    return $plain
  } finally {
    $credential = $null
    if ($null -ne $secure) { $secure.Dispose() }
  }
}

try {
  $key = Read-ProjectDeepSeekKey
} catch {
  Write-Error 'Project DeepSeek credential is unavailable or cannot be decrypted by this Windows user.'
  exit 1
}

if ($Action -eq 'status') {
  [ordered]@{
    available = $true
    decryptable = $true
    protection = 'windows-dpapi-current-user'
    repositoryContainsPlaintext = $false
  } | ConvertTo-Json -Compress
  $key = $null
  exit 0
}

if (-not $Command -or $Command.Count -eq 0) {
  $key = $null
  Write-Error 'The run action requires a command.'
  exit 2
}

$bindings = [ordered]@{
  DEEPSEEK_API_KEY = $key
  ZAICHANG_PROJECT_DEEPSEEK_KEY = $key
}
if ($Action -eq 'run-live') {
  $bindings.ZAICHANG_TEST_DEEPSEEK_KEY = $key
  $bindings.ZAICHANG_ALLOW_LIVE_EVAL = '1'
}
$previous = @{}
$exitCode = 0

try {
  foreach ($name in $bindings.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $bindings[$name], 'Process')
  }

  $executable = $Command[0]
  $commandArgs = if ($Command.Count -gt 1) { $Command[1..($Command.Count - 1)] } else { @() }
  [string[]]$commandArgs = if ($Command.Count -gt 1) { @($Command[1..($Command.Count - 1)]) } else { @() }
  $global:LASTEXITCODE = 0
  & $executable @commandArgs
  if (-not $?) {
    $exitCode = if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }
  } elseif ($LASTEXITCODE -is [int]) {
    $exitCode = $LASTEXITCODE
  }
} catch {
  Write-Error "Unable to run the requested command with the project DeepSeek credential: $($_.Exception.Message)"
  $exitCode = 1
} finally {
  foreach ($name in $bindings.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
  }
  $bindings.Clear()
  $key = $null
}

exit $exitCode
