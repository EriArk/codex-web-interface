#Requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repository 'ops\windows'
$artifacts = Join-Path $repository '.local\qa-enrollment'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$names = @('Start-Enrollment.ps1', 'EnrollmentUi.ps1', 'EnrollmentState.ps1', 'Enroll-Computer.ps1', 'Pair-ComputerSsh.ps1', 'Install-EnrolledRemote.ps1', 'Install-RemoteDesktop.ps1')
foreach ($name in $names) {
    $text = [IO.File]::ReadAllText((Join-Path $source $name), [Text.Encoding]::UTF8)
    # Exercise the actual Windows PS5 file decoding used by the downloaded package.
    $path = Join-Path $artifacts $name
    [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($true))
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ('PowerShell parsing failed: ' + $name + ': ' + ($errors.Message -join ', ')) }
}
. (Join-Path $artifacts 'EnrollmentUi.ps1')
. (Join-Path $artifacts 'EnrollmentState.ps1')
$statePath = Join-Path $artifacts ('state-' + [Guid]::NewGuid().ToString() + '.json')
$connection = @{ id = [Guid]::NewGuid().ToString(); baseUrl = 'https://fixture.invalid/' }
$sid = 'S-1-5-21-1-2-3-1001'; $machine = [Guid]::NewGuid().ToString(); $profile = 'C:\Users\Fixture'
try {
    if ((Initialize-CwEnrollmentState $statePath $connection $sid $machine $profile) -ne 0) { throw 'Fresh setup must start at zero.' }
    Save-CwEnrollmentStep 3
    . (Join-Path $artifacts 'EnrollmentState.ps1')
    if ((Initialize-CwEnrollmentState $statePath $connection $sid $machine $profile) -ne 3) { throw 'Interrupted setup did not resume.' }
    $refused = $false
    try { Initialize-CwEnrollmentState $statePath $connection $sid ([Guid]::NewGuid().ToString()) $profile | Out-Null } catch { $refused = $true }
    if (-not $refused) { throw 'Another machine reused setup state.' }
    Assert-CwReportIdentity @{ sid=$sid; machineGuid=$machine; profile=$profile } $sid $machine $profile
    $refused = $false
    try { Assert-CwReportIdentity @{ sid=$sid; machineGuid=$machine; profile=$profile } 'S-1-5-21-1-2-3-1002' $machine $profile } catch { $refused = $true }
    if (-not $refused) { throw 'Another user reused the submitted report.' }
} finally { Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue; $script:CwEnrollmentStatePath = $null }
$tokens = $null; $errors = $null
$pair = [Management.Automation.Language.Parser]::ParseFile((Join-Path $artifacts 'Pair-ComputerSsh.ps1'), [ref]$tokens, [ref]$errors)
$port = $pair.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-CwSshPort' }, $true)
. ([scriptblock]::Create($port.Extent.Text))
foreach ($example in @(
    @{ Protocol = 'TCP'; LocalPort = '22'; Expected = $true },
    @{ Protocol = '6'; LocalPort = @('443', '20-25'); Expected = $true },
    @{ Protocol = 'Any'; LocalPort = 'Any'; Expected = $true },
    @{ Protocol = 'UDP'; LocalPort = '22'; Expected = $false },
    @{ Protocol = 'TCP'; LocalPort = '23-65535'; Expected = $false },
    @{ Protocol = 'TCP'; LocalPort = '443'; Expected = $false }
)) {
    if ((Test-CwSshPort ([pscustomobject]$example)) -ne $example.Expected) { throw 'SSH firewall classification failed.' }
}
$remote = [Management.Automation.Language.Parser]::ParseFile((Join-Path $artifacts 'Install-EnrolledRemote.ps1'), [ref]$tokens, [ref]$errors)
foreach ($name in @('Test-CwRemotePort', 'Test-CwRemoteRule')) {
    $function = $remote.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($function.Extent.Text))
}
foreach ($example in @(
    @{ Protocol = 'TCP'; LocalPort = '5900'; Expected = $true },
    @{ Protocol = '6'; LocalPort = @('443', '5890-5999'); Expected = $true },
    @{ Protocol = 'Any'; LocalPort = 'Any'; Expected = $true },
    @{ Protocol = 'UDP'; LocalPort = '5900'; Expected = $false },
    @{ Protocol = 'TCP'; LocalPort = '5901-65535'; Expected = $false },
    @{ Protocol = 'TCP'; LocalPort = '443'; Expected = $false }
)) {
    if ((Test-CwRemotePort ([pscustomobject]$example)) -ne $example.Expected) { throw 'Remote firewall classification failed.' }
}
$rule = [pscustomobject]@{ Enabled='True'; Direction='Inbound'; Action='Allow'; Profile='Any' }
$ports = [pscustomobject]@{ Protocol='TCP'; LocalPort='5900' }
$addresses = [pscustomobject]@{ RemoteAddress='100.64.0.1' }
if (-not (Test-CwRemoteRule $rule $ports $addresses '100.64.0.1')) { throw 'Private Remote rule rejected.' }
$rule.Enabled = 'False'
if (Test-CwRemoteRule $rule $ports $addresses '100.64.0.1') { throw 'Disabled Remote rule accepted.' }
$rule.Enabled = 'True'; $addresses.RemoteAddress = 'Any'
if (Test-CwRemoteRule $rule $ports $addresses '100.64.0.1') { throw 'Public Remote rule accepted.' }
$addresses.RemoteAddress = '100.64.0.2'
if (Test-CwRemoteRule $rule $ports $addresses '100.64.0.1') { throw 'Another Hub Remote rule accepted.' }
$cmd = Join-Path $env:WINDIR 'System32\cmd.exe'
if (-not (Test-CwNativeLogin $cmd @('/c', 'exit', '0') 'fixture-login-ok.log')) { throw 'Native signed-in status failed.' }
if (Test-CwNativeLogin $cmd @('/c', 'exit', '1') 'fixture-login-out.log') { throw 'Native signed-out status failed.' }
if (Test-CwNativeLogin $cmd @('/c', 'type', (Join-Path $artifacts 'nonexistent-fixture.txt')) 'fixture-login-error.log') { throw 'Native stderr failure accepted.' }
if (-not (Test-CwNativeLogin $cmd @('/c', 'echo', '100.70.80.90') 'fixture-output.log')) { throw 'Native output probe failed.' }
if ((Get-CwTailnetAddress $cmd) -ne $null) { throw 'Invalid Tailnet response accepted.' }
# Create the real controls offscreen: no installer, SSH, account sign-in or visible window.
$create = (Get-Command New-CwWindow).ScriptBlock.ToString().Replace('$form.Show();', '')
& ([scriptblock]::Create($create))
try {
    $script:CwWindow.Opacity = 0
    $script:CwWindow.ShowInTaskbar = $false
    $script:CwWindow.Show()
    [Windows.Forms.Application]::DoEvents()
    Write-CwStep 3 '3 / 5 - Applications and CodexWeb components'
    Invoke-CwInstaller $cmd @('/c', 'exit', '0')
    $failedExit = $false
    try { Invoke-CwInstaller $cmd @('/c', 'exit', '7') } catch { $failedExit = $_.Exception.Message -match '7' }
    if (-not $failedExit) { throw 'Installer must preserve actual failure exit code 7.' }
    # Exercise the bootstrap's real invocation operator across a .ps1 boundary.
    # The former call operator lost script-scoped controls on resumed setup.
    $scopeDirectory = Join-Path $artifacts 'scope-probe'
    New-Item -ItemType Directory -Path $scopeDirectory -Force | Out-Null
    $scopeChild = Join-Path $scopeDirectory 'Enroll-Computer.ps1'
    [IO.File]::WriteAllText($scopeChild, 'param($ConnectionFile) $script:CwLog.AppendText("resume-marker"); Write-CwStep 2 "scope-step"')
    $bootstrap = [IO.File]::ReadAllText((Join-Path $source 'Start-Enrollment.ps1'))
    $invocation = ($bootstrap -split "`n" | Where-Object { $_ -match "^\s+[.&] \(Join-Path \`$directory 'Enroll-Computer.ps1'\)" })
    if (@($invocation).Count -ne 1) { throw 'Missing bootstrap invocation.' }
    $directory = $scopeDirectory; $descriptor = 'fixture'
    . ([scriptblock]::Create([string]$invocation))
    if ($script:CwLog.Text -notmatch 'resume-marker' -or $script:CwProgress.Value -ne 2) { throw 'Installer script lost window controls.' }
    $blob = [byte[]]::new(51)
    $blob[3] = 11; [Text.Encoding]::ASCII.GetBytes('ssh-ed25519').CopyTo($blob, 4); $blob[18] = 32
    Show-CwFingerprint ('ssh-ed25519 ' + [Convert]::ToBase64String($blob))
    if ($script:CwLog.Text -notmatch 'SHA256:[A-Za-z0-9+/]{43}') { throw 'Fingerprint is not visible.' }
    $script:CwWindow.CreateControl()
    $bitmap = [Drawing.Bitmap]::new($script:CwWindow.Width, $script:CwWindow.Height)
    try {
        $script:CwWindow.DrawToBitmap($bitmap, [Drawing.Rectangle]::new(0, 0, $bitmap.Width, $bitmap.Height))
        $bitmap.Save((Join-Path $artifacts 'wizard.png'), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
} finally { $script:CwWindow.Dispose() }
Write-Host 'PASS: Windows PS5 package parsing, 16 firewall cases, native login statuses, fingerprint and offscreen wizard rendering. No machine settings changed.'
