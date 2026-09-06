#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$HubAddress = '192.168.50.122',
    [string]$WindowsUser = 'EriArk',
    [string]$PublicKeyFile
)
$ErrorActionPreference = 'Stop'
if (-not $PublicKeyFile) {
    $PublicKeyFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..\.local\hub_ed25519.pub'
}
if ($HubAddress -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Use the Hub LAN IPv4 address.' }
$parsedHubAddress = [System.Net.IPAddress]::Parse($HubAddress)
$targetUser = Get-LocalUser -Name $WindowsUser
$publicKey = (Get-Content -LiteralPath $PublicKeyFile -Raw).Trim()
if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$') { throw 'Expected one Ed25519 public key.' }
$sshRoot = Join-Path $env:ProgramData 'ssh'
$sshdConfig = Join-Path $sshRoot 'sshd_config'
$sshBin = Join-Path $env:WINDIR 'System32\OpenSSH'
if (-not (Test-Path -LiteralPath (Join-Path $sshBin 'sshd.exe'))) { throw 'Install Windows OpenSSH Server first.' }
New-Item -ItemType Directory -Path $sshRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $sshdConfig)) {
    Copy-Item -LiteralPath (Join-Path $sshBin 'sshd_config_default') -Destination $sshdConfig
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $sshdConfig -Destination "$sshdConfig.codex-web-$stamp.bak"
$config = Get-Content -LiteralPath $sshdConfig -Raw
if ($config -notmatch '# Codex Web Hub key-only access') {
    $config += [Environment]::NewLine + (@(
        '# Codex Web Hub key-only access'
        "Match User $($WindowsUser.ToLowerInvariant())"
        '    PubkeyAuthentication yes'
        '    PasswordAuthentication no'
        '    AuthenticationMethods publickey'
        ''
    ) -join [Environment]::NewLine)
    [System.IO.File]::WriteAllText($sshdConfig, $config, [System.Text.UTF8Encoding]::new($false))
}
$adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
$isAdminAccount = @(Get-LocalGroupMember -Group $adminGroup | Where-Object { $_.SID -eq $targetUser.SID }).Count -gt 0
if ($isAdminAccount) {
    $authorizedKeys = Join-Path $sshRoot 'administrators_authorized_keys'
} else {
    $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $targetUser.SID.Value }
    if (-not $profile) { throw 'Cannot find target Windows user profile.' }
    $userSsh = Join-Path $profile.LocalPath '.ssh'
    New-Item -ItemType Directory -Path $userSsh -Force | Out-Null
    $authorizedKeys = Join-Path $userSsh 'authorized_keys'
}
$existingKeys = if (Test-Path -LiteralPath $authorizedKeys) { Get-Content -LiteralPath $authorizedKeys -Raw } else { '' }
$keyBody = ($publicKey -split ' ')[1]
if (-not $existingKeys.Contains($keyBody)) {
    $restrictedKey = 'from="' + $HubAddress + '",no-agent-forwarding,no-port-forwarding,no-pty ' + $publicKey
    $lines = @($existingKeys.TrimEnd(), $restrictedKey, '') -join [Environment]::NewLine
    [System.IO.File]::WriteAllText($authorizedKeys, $lines.TrimStart([char]13, [char]10), [System.Text.UTF8Encoding]::new($false))
}
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$sids = @('S-1-5-18')
if ($isAdminAccount) { $sids += 'S-1-5-32-544' } else { $sids += $targetUser.SID.Value }
foreach ($sid in $sids) {
    $principal = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow'))
}
Set-Acl -LiteralPath $authorizedKeys -AclObject $acl
& (Join-Path $sshBin 'ssh-keygen.exe') -A
if ($LASTEXITCODE -ne 0) { throw 'SSH host key generation failed.' }
# Host keys generated interactively must also be readable by the service only.
foreach ($hostKey in Get-ChildItem -LiteralPath $sshRoot -Filter 'ssh_host_*_key' -File) {
    $keyAcl = [System.Security.AccessControl.FileSecurity]::new()
    $keyAcl.SetAccessRuleProtection($true, $false)
    $keyAcl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $keyAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
    }
    Set-Acl -LiteralPath $hostKey.FullName -AclObject $keyAcl
}
& (Join-Path $sshBin 'sshd.exe') -t -f $sshdConfig
if ($LASTEXITCODE -ne 0) { throw 'SSH configuration validation failed. Review the timestamped backup.' }
$ruleName = 'CodexWeb-Hub-SSH'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
    Get-NetFirewallRule -Name $ruleName | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $HubAddress
    Enable-NetFirewallRule -Name $ruleName
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Codex Web: SSH from Linux Hub only' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress $HubAddress -Action Allow -Profile Any | Out-Null
}
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -eq 'Running') { Restart-Service sshd } else { Start-Service sshd }
Write-Host 'SSH is ready for the Linux Hub. No Codex network listener was opened.'
Get-Service sshd | Select-Object Name, Status, StartType
Get-Content -LiteralPath (Join-Path $sshRoot 'ssh_host_ed25519_key.pub')
