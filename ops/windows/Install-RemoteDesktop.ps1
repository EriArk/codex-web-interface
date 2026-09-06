#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$HubAddress,
    [string]$Installer,
    [string]$SecretFile
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
if (-not $Installer) { $Installer = Join-Path $repository '.local\tightvnc-2.8.88-gpl-setup-64bit.msi' }
if (-not $SecretFile) { $SecretFile = Join-Path $repository '.local\remote.env' }
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=OOO GlavSoft,') { throw 'The VNC installer signature is not trusted.' }
if (Get-Service -Name tvnserver -ErrorAction SilentlyContinue) { throw 'TightVNC already exists. Review its configuration before changing it.' }
$secrets = @{}
foreach ($line in [IO.File]::ReadAllLines($SecretFile)) {
    if ($line -match '^([A-Z_]+)=(.+)$') { $secrets[$matches[1]] = $matches[2] }
}
$password = $secrets['REMOTE_MAIN_WINDOWS_PASSWORD']
$controlPassword = $secrets['REMOTE_MAIN_WINDOWS_CONTROL_PASSWORD']
if ($password -notmatch '^[A-Za-z0-9]{8}$' -or $controlPassword -notmatch '^[a-f0-9]{32}$') { throw 'Invalid private VNC configuration.' }
$ruleName = 'CodexWeb-Hub-VNC'
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'Codex Web: VNC from Linux Hub only' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5900 -RemoteAddress $HubAddress -Profile Any | Out-Null
}
$arguments = @(
    '/i', ('"' + $Installer + '"'), '/quiet', '/norestart', 'ADDLOCAL=Server',
    'SERVER_REGISTER_AS_SERVICE=1', 'SERVER_ADD_FIREWALL_EXCEPTION=0',
    'SET_ACCEPTHTTPCONNECTIONS=1', 'VALUE_OF_ACCEPTHTTPCONNECTIONS=0',
    'SET_ACCEPTRFBCONNECTIONS=1', 'VALUE_OF_ACCEPTRFBCONNECTIONS=1',
    'SET_ALWAYSSHARED=1', 'VALUE_OF_ALWAYSSHARED=1',
    'SET_REMOVEWALLPAPER=1', 'VALUE_OF_REMOVEWALLPAPER=0',
    'SET_DISCONNECTACTION=1', 'VALUE_OF_DISCONNECTACTION=0',
    'SET_RUNCONTROLINTERFACE=1', 'VALUE_OF_RUNCONTROLINTERFACE=0',
    'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=1',
    'SET_PASSWORD=1', ('VALUE_OF_PASSWORD=' + $password),
    'SET_USECONTROLAUTHENTICATION=1', 'VALUE_OF_USECONTROLAUTHENTICATION=1',
    'SET_CONTROLPASSWORD=1', ('VALUE_OF_CONTROLPASSWORD=' + $controlPassword)
)
$installation = Start-Process -FilePath msiexec.exe -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
if ($installation.ExitCode -notin @(0,3010)) { throw ('TightVNC installation failed: ' + $installation.ExitCode) }
Set-Service -Name tvnserver -StartupType Automatic
Start-Service -Name tvnserver
$password = $null; $controlPassword = $null; $secrets.Clear(); $arguments = $null
Get-Service -Name tvnserver | Select-Object Name,Status,StartType
Get-NetFirewallRule -Name $ruleName | Get-NetFirewallAddressFilter | Select-Object RemoteAddress
