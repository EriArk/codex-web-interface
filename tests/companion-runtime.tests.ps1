$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../ops/windows/Copy-CompanionRuntime.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('companion-runtime-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $source = Join-Path $root 'OpenAI/Codex/bin/123456789abcdef0'
    $target = Join-Path $root 'companion'
    New-Item -ItemType Directory -Path $source -Force | Out-Null
    $files = @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')
    foreach ($name in $files) { [IO.File]::WriteAllText((Join-Path $source $name), 'fixture-' + $name) }
    $result = Copy-CompanionRuntime -CodexCommand (Join-Path $source 'codex.exe') -TargetDirectory $target
    if ($result -eq (Join-Path $source 'codex.exe')) { throw 'Desktop bundle was not pinned' }
    if ((Copy-CompanionRuntime -CodexCommand (Join-Path $source 'codex.exe') -TargetDirectory $target) -ne $result) { throw 'Reinstall is not idempotent' }
    Remove-Item -LiteralPath (Join-Path $source 'codex-code-mode-host.exe')
    if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $result) 'codex-code-mode-host.exe'))) { throw 'Desktop cleanup broke the pinned runtime' }
    $rejected = $false
    try { Copy-CompanionRuntime -CodexCommand (Join-Path $source 'codex.exe') -TargetDirectory $target | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Incomplete source was accepted' }
    $standalone = Join-Path $root 'codex.exe'
    [IO.File]::WriteAllText($standalone, 'custom fixture')
    if ((Copy-CompanionRuntime -CodexCommand $standalone -TargetDirectory $target) -ne $standalone) { throw 'Custom command was changed' }
    Write-Output 'Companion runtime: pinning, update isolation, reinstall, incomplete bundle and custom command passed.'
} finally {
    $resolved = [IO.Path]::GetFullPath($root)
    $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'companion-runtime-test-*') { throw 'Unexpected test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
