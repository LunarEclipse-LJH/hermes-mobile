# Register the Hermes Mobile watchdog for the current user (run once per machine).
#   powershell -NoProfile -ExecutionPolicy Bypass -File install_watchdog.ps1
#
# Everything is derived from this script's own folder, so the repo can live anywhere.
# Three triggers: logon, every 5 minutes, and resume from sleep (Power-Troubleshooter 1).
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$name = 'Hermes Mobile Watchdog'

$pyw = (Get-ChildItem "$env:LOCALAPPDATA\hermes\tools\python-*\pythonw.exe" |
        Select-Object -First 1).FullName
if (-not $pyw) {
    throw 'pythonw.exe not found under %LOCALAPPDATA%\hermes\tools\python-*\ - install Hermes first.'
}

$action = New-ScheduledTaskAction -Execute $pyw `
    -Argument ('"' + $base + '\watchdog_launcher.pyw"') `
    -WorkingDirectory $base

$t1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$t2 = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# resume from sleep / Modern Standby
$cimClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$t3 = New-CimInstance -CimClass $cimClass -ClientOnly
$t3.Enabled = $true
$t3.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and EventID=1]]</Select></Query></QueryList>'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $t1, $t2, $t3 `
    -Settings $settings -Principal $principal `
    -Description 'Restarts the hermes-mobile dashboard/bridge when either listener disappears.' -Force | Out-Null

"registered: $name"
"  action : $pyw `"$base\watchdog_launcher.pyw`""
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-List
