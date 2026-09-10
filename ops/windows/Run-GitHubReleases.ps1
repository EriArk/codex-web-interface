$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
& $config.node (Join-Path $PSScriptRoot 'GitHubReleases.cjs') worker
exit $LASTEXITCODE
