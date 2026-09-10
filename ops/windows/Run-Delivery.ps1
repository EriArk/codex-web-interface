$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
& $config.node (Join-Path $PSScriptRoot 'DeliveryWorker.cjs') worker
exit $LASTEXITCODE
