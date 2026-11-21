# Regenerate addrs.json (served to the phone page) and print the current phone URLs.
# The campus RA prefix changes on reconnect/reboot and the address expires every
# few hours, so NOTHING may hardcode it. ASCII only: PowerShell 5.1 reads BOM-less
# .ps1 as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$port = 9119

function Test-Bind([string]$ip) {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $t = $c.ConnectAsync($ip, $port)
        if ($t.Wait(1200) -and $c.Connected) { return $true }
    } catch { } finally { $c.Dispose() }
    return $false
}

# --- IPv6: preferred global RA addresses; link-suffix (stable) before random ---
$v6 = @(Get-NetIPAddress -AddressFamily IPv6 -PrefixOrigin RouterAdvertisement |
        Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike 'fe80*' } |
        Sort-Object SuffixOrigin |
        ForEach-Object { $_.IPAddress })

# --- IPv4: real NICs only; skip loopback / APIPA / Hyper-V / WSL switches.
# These exist only because ipv4_bridge.py relays 0.0.0.0:PORT to [::1]; a phone
# on this laptop's hotspot has IPv4 only, and 192.168.137.1 never rotates.
$v4 = @(Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Bluetooth|Hyper-V'
        } |
        Sort-Object { if ($_.IPAddress -eq '192.168.137.1') { 0 } else { 1 } } |
        ForEach-Object { $_.IPAddress })

$urls = @()
foreach ($a in $v6) { $urls += "http://[$a]:$port/" }
foreach ($a in $v4) { $urls += "http://${a}:$port/" }
$urls += "http://localhost:$port/"

$obj = [ordered]@{
  port    = $port
  updated = (Get-Date).ToString('o')
  ipv6    = @($v6)
  ipv4    = @($v4)
  urls    = $urls
}
$json = $obj | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $root 'addrs.json'), $json, (New-Object Text.UTF8Encoding($false)))

if ($v6.Count -eq 0) {
  Write-Host '  Phone: no global IPv6 right now (check WLAN / campus RA)'
} else {
  foreach ($a in $v6) { Write-Host ("  Phone: http://[$a]:$port/") }
}

# Advertise an IPv4 address only if it accepts a connection right now - which is
# also the proof that ipv4_bridge.py survived this start.
$v4ok = $false
foreach ($a in $v4) {
  if (Test-Bind $a) { $v4ok = $true; Write-Host ("  Phone: http://${a}:$port/      (IPv4 bridge)") }
}
if ($v4.Count -gt 0 -and -not $v4ok) {
  Write-Host '  [warn] IPv4 bridge not answering - start.cmd must run ipv4_bridge.py'
}
