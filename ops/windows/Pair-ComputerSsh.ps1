#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)]$Connection)
$ErrorActionPreference = 'Stop'
function Test-CwSshPort($filter) {
    if ([string]$filter.Protocol -notin @('TCP', '6', 'Any', '256')) { return $false }
    foreach ($port in @($filter.LocalPort)) {
        if ([string]$port -in @('Any', '22')) { return $true }
        if ([string]$port -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le 22 -and [int]$Matches[2] -ge 22) { return $true }
    }
    return $false
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($Connection.hubAddress -notmatch '^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -or [int]$Matches[1] -lt 64 -or [int]$Matches[1] -gt 127 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 255) { throw 'Expected the Hub Tailscale IPv4 address.' }
foreach ($key in @($Connection.commandKey, $Connection.terminalKey)) {
    if ($key -notmatch '^ssh-ed25519 [A-Za-z0-9+/]{68}$') { throw 'Invalid connection public key.' }
}
$sshRoot = Join-Path $env:ProgramData 'ssh'
$sshBin = Join-Path $env:WINDIR 'System32\OpenSSH'
$ancestor = $sshRoot
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'OpenSSH configuration directory contains a link.' }
    $ancestor = Split-Path -Parent $ancestor
}
if (-not (Test-Path -LiteralPath (Join-Path $sshBin 'sshd.exe'))) {
    Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
}
if (-not (Test-Path -LiteralPath (Join-Path $sshBin 'sshd.exe'))) { throw 'Windows could not install OpenSSH Server. Install it in Optional features and run this file again.' }
New-Item -ItemType Directory -Path $sshRoot -Force | Out-Null
$configPath = Join-Path $sshRoot 'sshd_config'
if (-not (Test-Path -LiteralPath $configPath)) { Copy-Item -LiteralPath (Join-Path $sshBin 'sshd_config_default') -Destination $configPath }
& (Join-Path $sshBin 'ssh-keygen.exe') -A
if ($LASTEXITCODE -ne 0) { throw 'OpenSSH host key generation failed.' }
# Host keys must remain usable by sshd/SYSTEM and unreadable to other local users.
foreach ($hostKeyFile in @(Get-ChildItem -LiteralPath $sshRoot -Filter 'ssh_host_*_key' -File)) {
    if ($hostKeyFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'OpenSSH host key contains a link.' }
    $hostAcl = [Security.AccessControl.FileSecurity]::new()
    $hostAcl.SetAccessRuleProtection($true, $false)
    $hostAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $hostAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
    }
    Set-Acl -LiteralPath $hostKeyFile.FullName -AclObject $hostAcl
}
# Inspect the effective configuration instead of adding Match blocks or restarting an existing service.
$windowsUser = $identity.Name.Split('\')[-1]
$effective = @(& (Join-Path $sshBin 'sshd.exe') -T -f $configPath -C ('user=' + $windowsUser.ToLowerInvariant() + ',host=codex-hub,addr=' + $Connection.hubAddress))
if ($LASTEXITCODE -ne 0) { throw 'OpenSSH configuration is invalid. Existing configuration was preserved.' }
$authorizedLine = @($effective | Where-Object { $_ -match '^authorizedkeysfile ' })
if ($authorizedLine.Count -ne 1) { throw 'Cannot resolve the configured authorized_keys file.' }
$keySetting = $authorizedLine[0].Substring(19).Trim()
if ($keySetting -eq '__PROGRAMDATA__/ssh/administrators_authorized_keys') {
    $authorizedKeys = Join-Path $sshRoot 'administrators_authorized_keys'
    $keyOwner = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
} elseif ($keySetting -in @('.ssh/authorized_keys', '.ssh\authorized_keys')) {
    $authorizedKeys = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
    $keyOwner = $identity.User
} else { throw 'Custom AuthorizedKeysFile needs manual review. Existing SSH settings were preserved.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $authorizedKeys) -Force | Out-Null
$ancestor = $authorizedKeys
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'SSH key path contains a link.' }
    $ancestor = Split-Path -Parent $ancestor
}
$existing = if (Test-Path -LiteralPath $authorizedKeys) { [IO.File]::ReadAllText($authorizedKeys) } else { '' }
if ($existing) { Copy-Item -LiteralPath $authorizedKeys -Destination ($authorizedKeys + '.codexweb-' + $Connection.id + '.bak') -Force }
$lines = @($existing.TrimEnd())
foreach ($kind in @('command', 'terminal')) {
    $key = if ($kind -eq 'command') { $Connection.commandKey } else { $Connection.terminalKey }
    if (-not $existing.Contains($key)) {
        $restrictions = 'from="' + $Connection.hubAddress + '",no-agent-forwarding,no-port-forwarding,no-X11-forwarding'
        if ($kind -eq 'command') { $restrictions += ',no-pty' }
        $lines += $restrictions + ' ' + $key + ' codexweb-' + $Connection.id + '-' + $kind
    }
}
# Set the private ACL before publishing a key, retaining every unrelated key line.
if (-not (Test-Path -LiteralPath $authorizedKeys)) { [IO.File]::WriteAllText($authorizedKeys, '', [Text.UTF8Encoding]::new($false)) }
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($keyOwner)
foreach ($sid in @([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), $keyOwner)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
}
Set-Acl -LiteralPath $authorizedKeys -AclObject $acl
[IO.File]::WriteAllText($authorizedKeys, (($lines -join "`r`n").TrimStart() + "`r`n"), [Text.UTF8Encoding]::new($false))
& (Join-Path $sshBin 'sshd.exe') -t -f $configPath
if ($LASTEXITCODE -ne 0) { throw 'OpenSSH validation failed.' }
$ruleName = 'CodexWeb-Pair-' + $Connection.id
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'CodexWeb private Hub SSH' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress $Connection.hubAddress -Action Allow -Profile Any | Out-Null
}
# Scope the standard Windows OpenSSH rule only; custom SSH rules remain visible for review.
$defaultRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($defaultRule -and $defaultRule.Enabled -eq 'True') {
    Write-Host 'Windows has a standard SSH rule allowing incoming connections. This master will disable that standard rule and use the Hub-only rule.'
    if (-not (Confirm-Cw 'Разрешить SSH только от приватного адреса Hub вместо стандартного правила Windows «от всех»? Другие правила брандмауэра останутся без изменений.')) { throw 'Проверьте правило SSH перед продолжением.' }
    $defaultRule | Disable-NetFirewallRule
}
# Do not silently inherit an unrelated broad rule on a freshly enabled SSH service.
# Existing custom rules are never rewritten; a non-standard setup needs an explicit local review.
foreach ($rule in @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow)) {
    $portFilter = $rule | Get-NetFirewallPortFilter
    if (-not (Test-CwSshPort $portFilter)) { continue }
    $application = $rule | Get-NetFirewallApplicationFilter
    # AppContainer rules may say Program=Any but apply only to their package, never sshd.
    if ([string]$application.Package -notin @('', 'Any')) { continue }
    $service = $rule | Get-NetFirewallServiceFilter
    $programPath = [Environment]::ExpandEnvironmentVariables([string]$application.Program)
    if ($programPath -notin @('Any', (Join-Path $sshBin 'sshd.exe')) -or [string]$service.Service -notin @('Any', 'sshd')) { continue }
    $addresses = @(($rule | Get-NetFirewallAddressFilter).RemoteAddress)
    if (@($addresses | Where-Object { $_ -notin @($Connection.hubAddress, ($Connection.hubAddress + '/32')) }).Count -gt 0 -or -not $addresses.Count) {
        throw ('Правило брандмауэра «' + $rule.DisplayName + '» открывает SSH не только для Hub. Ограничьте его приватным адресом ' + $Connection.hubAddress + ' в Windows и запустите мастер повторно. Это правило мастер не изменял.')
    }
}
Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }
Write-Host 'SSH keys and the Hub-only firewall rule are ready. Existing SSH sessions were not restarted.'
