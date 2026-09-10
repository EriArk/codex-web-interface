$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
& $config.node (Join-Path $PSScriptRoot 'ProjectSetupWorker.cjs') worker
exit $LASTEXITCODE
