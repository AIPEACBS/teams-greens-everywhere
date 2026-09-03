Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TeamsGreensEverywhereInput {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
'@

$script:AppName = 'Teams Greens Everywhere'
$script:AppDirectory = Join-Path $env:LOCALAPPDATA 'TeamsGreensEverywhere'
$script:SettingsPath = Join-Path $script:AppDirectory 'settings.json'
$script:ResolvedPath = Join-Path $script:AppDirectory 'resolved-schedule.json'
$script:PidPath = Join-Path $script:AppDirectory 'runtime.pid'
$script:MutexName = 'Local\TeamsGreensEverywhere'
$script:DayKeys = @('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat')
$script:Random = New-Object System.Random
$script:ActiveNow = $false
$script:IsShuttingDown = $false
$script:LastSignalAt = $null
$script:SignalInterval = [TimeSpan]::FromMinutes(1)
$script:LoopbackPort = 23920

function New-DefaultSettings {
    $schedule = [ordered]@{}
    foreach ($day in @('mon', 'tue', 'wed', 'thu', 'fri')) {
        $schedule[$day] = [ordered]@{ enabled = $true; periods = @([ordered]@{ start = '09:00'; end = '17:00'; startJitter = 10; endJitter = 10 }) }
    }
    foreach ($day in @('sat', 'sun')) { $schedule[$day] = [ordered]@{ enabled = $false; periods = @() } }
    return [pscustomobject]@{ version = 2; revision = 1; enabled = $true; timezone = [System.TimeZoneInfo]::Local.Id; loopbackPort = 23920; schedule = [pscustomobject]$schedule }
}

function Save-Json {
    param($Value, [string]$Path)
    New-Item -ItemType Directory -Path $script:AppDirectory -Force | Out-Null
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-Settings {
    if (Test-Path -LiteralPath $script:SettingsPath -PathType Leaf) {
        try {
            $loaded = Get-Content -LiteralPath $script:SettingsPath -Raw | ConvertFrom-Json
            if ($loaded.version -eq 2 -and $loaded.schedule) {
                if ($loaded.timezone -eq 'auto') { $loaded.timezone = [System.TimeZoneInfo]::Local.Id }
                if (-not $loaded.revision) { $loaded | Add-Member -NotePropertyName revision -NotePropertyValue 1 }
                if (-not $loaded.loopbackPort) { $loaded | Add-Member -NotePropertyName loopbackPort -NotePropertyValue 23920 }
                return $loaded
            }
        } catch { }
    }
    return New-DefaultSettings
}

function Save-Settings {
    $script:Settings.revision = [int]$script:Settings.revision + 1
    Save-Json $script:Settings $script:SettingsPath
    $script:Resolved = [pscustomobject]@{}
    Save-Json $script:Resolved $script:ResolvedPath
}

function Persist-Settings {
    Save-Json $script:Settings $script:SettingsPath
}

function Get-ResolvedCache {
    if (Test-Path -LiteralPath $script:ResolvedPath -PathType Leaf) {
        try { return (Get-Content -LiteralPath $script:ResolvedPath -Raw | ConvertFrom-Json) } catch { }
    }
    return [pscustomobject]@{}
}

$script:Settings = Get-Settings
$script:Resolved = Get-ResolvedCache
Save-Json $script:Settings $script:SettingsPath

function Get-TimeZone {
    try { return [System.TimeZoneInfo]::FindSystemTimeZoneById($script:Settings.timezone) }
    catch { return [System.TimeZoneInfo]::Local }
}

function Get-ZonedNow {
    return [System.TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow, (Get-TimeZone)).DateTime
}

function Get-DayKey {
    param([datetime]$Date)
    return $script:DayKeys[[int]$Date.DayOfWeek]
}

function Get-DateKey {
    param([datetime]$Date)
    return $Date.ToString('yyyy-MM-dd')
}

function Get-TimeOfDay {
    param([string]$Value)
    if ($Value -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "Invalid time: $Value" }
    return [TimeSpan]::ParseExact($Value, 'hh\:mm', $null)
}

function Get-ResolvedPeriods {
    param([datetime]$Date)

    $dateKey = Get-DateKey $Date
    $dayKey = Get-DayKey $Date
    $day = $script:Settings.schedule.PSObject.Properties[$dayKey].Value
    $signature = '{0}:{1}' -f $script:Settings.revision, ($day | ConvertTo-Json -Compress -Depth 6)
    $cached = $script:Resolved.PSObject.Properties[$dateKey].Value
    if ($cached -and $cached.signature -eq $signature) {
        return @($cached.periods | ForEach-Object { [pscustomobject]@{ Start = [datetime]::Parse($_.start); End = [datetime]::Parse($_.end) } })
    }

    $periods = @()
    if ($day -and $day.enabled) {
        foreach ($period in @($day.periods)) {
            $start = $Date.Date.Add((Get-TimeOfDay $period.start))
            $end = $Date.Date.Add((Get-TimeOfDay $period.end))
            if ($end -le $start) { $end = $end.AddDays(1) }
            $startRange = [Math]::Max(0, [int]$period.startJitter)
            $endRange = [Math]::Max(0, [int]$period.endJitter)
            $start = $start.AddMinutes($script:Random.Next(-$startRange, $startRange + 1))
            $end = $end.AddMinutes($script:Random.Next(-$endRange, $endRange + 1))
            $periods += [pscustomobject]@{ Start = $start; End = $end }
        }
    }

    $entry = [pscustomobject]@{
        signature = $signature
        periods = @($periods | ForEach-Object { [pscustomobject]@{ start = $_.Start.ToString('o'); end = $_.End.ToString('o') } })
    }
    $script:Resolved | Add-Member -NotePropertyName $dateKey -NotePropertyValue $entry -Force
    Save-Json $script:Resolved $script:ResolvedPath
    return $periods
}

function Test-ScheduleActive {
    $now = Get-ZonedNow
    $periods = @(Get-ResolvedPeriods $now.AddDays(-1)) + @(Get-ResolvedPeriods $now)
    return @($periods | Where-Object { $now -ge $_.Start -and $now -le $_.End }).Count -gt 0
}

function Invoke-PresenceSignal {
    $key = [byte]0x91
    $keyUp = [uint32]0x0002
    [TeamsGreensEverywhereInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
    [TeamsGreensEverywhereInput]::keybd_event($key, 0, $keyUp, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [TeamsGreensEverywhereInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero)
    [TeamsGreensEverywhereInput]::keybd_event($key, 0, $keyUp, [UIntPtr]::Zero)
    $script:LastSignalAt = Get-Date
}

function Start-Loopback {
    $script:Listener = New-Object System.Net.HttpListener
    $script:Listener.Prefixes.Add(('http://127.0.0.1:{0}/' -f $script:Settings.loopbackPort))
    try {
        $script:Listener.Start()
        $script:ListenerRequest = $script:Listener.BeginGetContext($null, $null)
    } catch {
        $script:Listener = $null
        $script:ListenerRequest = $null
    }
}

function Process-Loopback {
    if (-not $script:ListenerRequest -or -not $script:ListenerRequest.IsCompleted) { return }
    try {
        $context = $script:Listener.EndGetContext($script:ListenerRequest)
        $body = [System.Text.Encoding]::UTF8.GetBytes((@{ active = $script:ActiveNow; running = $script:Settings.enabled } | ConvertTo-Json -Compress))
        $context.Response.StatusCode = 200
        $context.Response.ContentType = 'application/json'
        $context.Response.AddHeader('Access-Control-Allow-Origin', '*')
        $context.Response.ContentLength64 = $body.Length
        $context.Response.OutputStream.Write($body, 0, $body.Length)
        $context.Response.Close()
    } finally {
        if ($script:Listener -and $script:Listener.IsListening) { $script:ListenerRequest = $script:Listener.BeginGetContext($null, $null) }
    }
}

function Stop-Loopback {
    if ($script:Listener) { $script:Listener.Stop(); $script:Listener.Close() }
}

function Update-Tray {
    $state = if (-not $script:Settings.enabled) { 'Stopped' } elseif ($script:ActiveNow) { 'Active now' } else { 'Waiting for schedule' }
    $script:StatusItem.Text = "Status: $state"
    $script:StartStopItem.Text = if ($script:Settings.enabled) { 'Stop' } else { 'Start' }
    $script:NotifyIcon.Text = "$($script:AppName) - $state"
    $script:NotifyIcon.Icon = if ($script:Settings.enabled) { [System.Drawing.SystemIcons]::Information } else { [System.Drawing.SystemIcons]::Warning }
}

function Show-Settings {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "$($script:AppName) Settings"
    $form.Size = New-Object System.Drawing.Size(800, 500)
    $form.StartPosition = 'CenterScreen'

    $timezoneLabel = New-Object System.Windows.Forms.Label
    $timezoneLabel.Text = 'Timezone:'
    $timezoneLabel.Location = New-Object System.Drawing.Point(12, 16)
    $timezoneLabel.AutoSize = $true
    $form.Controls.Add($timezoneLabel)
    $timezone = New-Object System.Windows.Forms.ComboBox
    $timezone.Location = New-Object System.Drawing.Point(80, 12)
    $timezone.Width = 420
    $timezone.DropDownStyle = 'DropDownList'
    foreach ($zone in [System.TimeZoneInfo]::GetSystemTimeZones()) { [void]$timezone.Items.Add($zone.Id) }
    $timezone.SelectedItem = $script:Settings.timezone
    $form.Controls.Add($timezone)

    $grid = New-Object System.Windows.Forms.DataGridView
    $grid.Location = New-Object System.Drawing.Point(12, 48)
    $grid.Size = New-Object System.Drawing.Size(760, 340)
    $grid.AllowUserToAddRows = $false
    $grid.RowHeadersVisible = $false
    [void]$grid.Columns.Add('Day', 'Day')
    [void]$grid.Columns.Add('Start', 'Start (HH:mm)')
    [void]$grid.Columns.Add('End', 'End (HH:mm)')
    [void]$grid.Columns.Add('StartJitter', 'Start variation (min)')
    [void]$grid.Columns.Add('EndJitter', 'End variation (min)')
    $enabledColumn = New-Object System.Windows.Forms.DataGridViewCheckBoxColumn
    $enabledColumn.Name = 'Enabled'
    $enabledColumn.HeaderText = 'Enabled'
    [void]$grid.Columns.Add($enabledColumn)
    foreach ($dayKey in @('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')) {
        $day = $script:Settings.schedule.$dayKey
        foreach ($period in @($day.periods)) {
            [void]$grid.Rows.Add($dayKey, $period.start, $period.end, $period.startJitter, $period.endJitter, $day.enabled)
        }
    }
    $form.Controls.Add($grid)

    $add = New-Object System.Windows.Forms.Button
    $add.Text = 'Add period'
    $add.Location = New-Object System.Drawing.Point(12, 402)
    $add.Add_Click({ [void]$grid.Rows.Add('mon', '09:00', '17:00', 10, 10, $true) })
    $form.Controls.Add($add)
    $remove = New-Object System.Windows.Forms.Button
    $remove.Text = 'Remove selected'
    $remove.Location = New-Object System.Drawing.Point(112, 402)
    $remove.Add_Click({ foreach ($row in @($grid.SelectedRows)) { if (-not $row.IsNewRow) { $grid.Rows.Remove($row) } } })
    $form.Controls.Add($remove)
    $save = New-Object System.Windows.Forms.Button
    $save.Text = 'Save'
    $save.Location = New-Object System.Drawing.Point(632, 402)
    $save.Add_Click({
        try {
            $next = [ordered]@{}
            foreach ($key in @('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')) { $next[$key] = [ordered]@{ enabled = $false; periods = @() } }
            foreach ($row in $grid.Rows) {
                if ($row.IsNewRow) { continue }
                $key = [string]$row.Cells['Day'].Value
                if ($key -notin @('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')) { throw "Unknown day: $key" }
                $start = [string]$row.Cells['Start'].Value; $end = [string]$row.Cells['End'].Value
                [void](Get-TimeOfDay $start); [void](Get-TimeOfDay $end)
                $next[$key].enabled = [bool]$row.Cells['Enabled'].Value
                $next[$key].periods += [pscustomobject]@{ start = $start; end = $end; startJitter = [Math]::Max(0, [int]$row.Cells['StartJitter'].Value); endJitter = [Math]::Max(0, [int]$row.Cells['EndJitter'].Value) }
            }
            $script:Settings.timezone = [string]$timezone.SelectedItem
            $script:Settings.schedule = [pscustomobject]$next
            Save-Settings
            Update-Tray
            $form.Close()
        } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, $script:AppName) | Out-Null }
    })
    $form.Controls.Add($save)
    $form.ShowDialog() | Out-Null
}

$createdNew = $false
$script:Mutex = New-Object System.Threading.Mutex($true, $script:MutexName, [ref]$createdNew)
if (-not $createdNew) { return }

New-Item -ItemType Directory -Path $script:AppDirectory -Force | Out-Null
Set-Content -LiteralPath $script:PidPath -Value $PID -NoNewline

$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:NotifyIcon.Visible = $true
$script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:StatusItem = New-Object System.Windows.Forms.ToolStripMenuItem('Status: starting')
$script:StatusItem.Enabled = $false
$script:StartStopItem = New-Object System.Windows.Forms.ToolStripMenuItem('Stop')
$runOnce = New-Object System.Windows.Forms.ToolStripMenuItem('Run Once Now')
$settingsItem = New-Object System.Windows.Forms.ToolStripMenuItem('Settings')
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Exit')
$script:StartStopItem.Add_Click({ $script:Settings.enabled = -not $script:Settings.enabled; Persist-Settings; Update-Tray })
$runOnce.Add_Click({ Invoke-PresenceSignal; Update-Tray })
$settingsItem.Add_Click({ Show-Settings })
$exitItem.Add_Click({ $script:IsShuttingDown = $true; [System.Windows.Forms.Application]::Exit() })
[void]$script:Menu.Items.Add($script:StatusItem)
[void]$script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$script:Menu.Items.Add($script:StartStopItem)
[void]$script:Menu.Items.Add($runOnce)
[void]$script:Menu.Items.Add($settingsItem)
[void]$script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$script:Menu.Items.Add($exitItem)
$script:NotifyIcon.ContextMenuStrip = $script:Menu

Start-Loopback
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    Process-Loopback
    $script:ActiveNow = $script:Settings.enabled -and (Test-ScheduleActive)
    if ($script:ActiveNow -and (-not $script:LastSignalAt -or (Get-Date) - $script:LastSignalAt -ge $script:SignalInterval)) { Invoke-PresenceSignal }
    Update-Tray
})
$timer.Start()
Update-Tray

[System.Windows.Forms.Application]::Add_ApplicationExit({
    $timer.Stop(); $timer.Dispose()
    Stop-Loopback
    $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose()
    Remove-Item -LiteralPath $script:PidPath -Force -ErrorAction SilentlyContinue
    $script:Mutex.ReleaseMutex(); $script:Mutex.Dispose()
})
[System.Windows.Forms.Application]::Run()
