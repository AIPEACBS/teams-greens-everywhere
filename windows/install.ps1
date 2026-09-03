param(
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppName = 'Teams Greens Everywhere'
$RunValueName = 'TeamsGreensEverywhere'
$AppDirectory = Join-Path $env:LOCALAPPDATA 'TeamsGreensEverywhere'
$RuntimePath = Join-Path $AppDirectory 'teams-green-everywhere.ps1'
$SettingsPath = Join-Path $AppDirectory 'settings.json'
$PidPath = Join-Path $AppDirectory 'runtime.pid'
$RuntimeUrl = 'https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/windows/teams-green-everywhere.ps1'
$SettingsUrl = 'https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/windows/settings.json'
$RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$LegacyRunValueName = 'TeamsGreenEverywhere'
$LegacyAppDirectory = Join-Path $env:LOCALAPPDATA 'TeamsGreenEverywhere'

function Stop-InstalledRuntime {
    param([string]$RuntimePidPath)

    if (-not (Test-Path -LiteralPath $RuntimePidPath -PathType Leaf)) {
        return
    }

    $runtimePid = Get-Content -LiteralPath $RuntimePidPath -Raw
    if ($runtimePid -match '^\d+$') {
        Stop-Process -Id ([int]$runtimePid) -Force -ErrorAction SilentlyContinue
    }
}

if ($Uninstall) {
    Stop-InstalledRuntime $PidPath
    Stop-InstalledRuntime (Join-Path $LegacyAppDirectory 'runtime.pid')
    Remove-ItemProperty -Path $RunKeyPath -Name $RunValueName -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RunKeyPath -Name $LegacyRunValueName -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $AppDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $LegacyAppDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "$AppName was removed."
    return
}

$legacyPidPath = Join-Path $LegacyAppDirectory 'runtime.pid'
Stop-InstalledRuntime $legacyPidPath
Remove-ItemProperty -Path $RunKeyPath -Name $LegacyRunValueName -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $LegacyAppDirectory -Recurse -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $AppDirectory -Force | Out-Null
Invoke-WebRequest -Uri $RuntimeUrl -OutFile $RuntimePath

# Install default settings only if none exist yet
if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
    Invoke-WebRequest -Uri $SettingsUrl -OutFile $SettingsPath
}

$runtimeCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $RuntimePath
New-ItemProperty -Path $RunKeyPath -Name $RunValueName -Value $runtimeCommand -PropertyType String -Force | Out-Null

Stop-InstalledRuntime $PidPath
Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $RuntimePath) -WindowStyle Hidden

Write-Host "$AppName is installed and running. It will start when you sign in to Windows."
Write-Host "Right-click the tray icon to change schedule, timezone, or jitter settings."
