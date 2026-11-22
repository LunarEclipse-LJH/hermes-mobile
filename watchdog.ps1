# Hermes Mobile watchdog - started by Task Scheduler, not by a shell session.
# Checks both listeners (IPv6 dashboard + IPv4 bridge) and repairs what is missing.
# All spawns go through WMI so the child lands under WmiPrvSE, outside any job object.
$ErrorActionPreference = 'SilentlyContinue'
$base = $PSScriptRoot
$log  = Join-Path $base 'watchdog.log'

function Log([string]$m) {
    Add-Content -Path $log -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

# keep the log bounded, same spirit as the bridge supervisor
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 512KB)) {
    Move-Item -Path $log -Destination ($log + '.1') -Force
}

function Start-Hidden([string]$cmdline) {
    $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine               = $cmdline
        CurrentDirectory          = $base
        ProcessStartupInformation = $si
    }
}

$listeners = Get-NetTCPConnection -LocalPort 9119 -State Listen
$v6 = @($listeners | Where-Object { $_.LocalAddress -eq '::' }).Count -gt 0
$v4 = @($listeners | Where-Object { $_.LocalAddress -eq '0.0.0.0' }).Count -gt 0

if ($v6 -and $v4) { exit 0 }

if (-not $v6) {
    Log 'IPv6 dashboard missing - starting full chain (hidden)'
    $r = Start-Hidden ('cmd.exe /c ' + $base + '\start.cmd >> ' + $base + '\dashboard.log 2>&1')
    Log ('start.cmd return={0} pid={1}' -f $r.ReturnValue, $r.ProcessId)
    exit 0
}

if (-not $v4) {
    Log 'IPv4 bridge missing - start bridge only (hidden)'
    $py = (Get-ChildItem "$env:LOCALAPPDATA\hermes\tools\python-*\python.exe" |
           Select-Object -First 1).FullName
    if (-not $py) { Log 'no bundled python found'; exit 1 }
    $r = Start-Hidden ('"' + $py + '" "' + $base + '\bridge_supervisor.py" 9119')
    Log ('bridge return={0} pid={1}' -f $r.ReturnValue, $r.ProcessId)
}
