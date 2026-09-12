param([string]$SourceRoot)
$ErrorActionPreference = 'Stop'
$billingRoot = if ($SourceRoot) { (Resolve-Path -LiteralPath $SourceRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$billingSandbox = Join-Path $env:TEMP ('qiji-token-billing-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$billingSandbox/src", "$billingSandbox/server/scripts", "$billingSandbox/server/data" -Force | Out-Null
Copy-Item -LiteralPath "$billingRoot/src/contract.ts" -Destination "$billingSandbox/src"
Copy-Item -LiteralPath "$billingRoot/server/src", "$billingRoot/server/skills" -Destination "$billingSandbox/server" -Recurse
Copy-Item -LiteralPath "$billingRoot/server/package.json", "$billingRoot/server/tsconfig.json" -Destination "$billingSandbox/server"
Copy-Item -LiteralPath "$PSScriptRoot/../server/scripts/smoke-text-billing.mjs", "$PSScriptRoot/../server/scripts/smoke-text-billing-restart.mjs" -Destination "$billingSandbox/server/scripts"
New-Item -ItemType Junction -Path "$billingSandbox/server/node_modules" -Target "$billingRoot/server/node_modules" | Out-Null
# Empty isolated data; no credentials or business database are copied. All upstream calls are stubbed.
Write-Output "TEXT_BILLING_SANDBOX=$billingSandbox"
Push-Location "$billingSandbox/server"
try {
  & node --import tsx scripts/smoke-text-billing.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Text billing smoke failed' }
  & node --import tsx scripts/smoke-text-billing-restart.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Text billing restart check failed' }
} finally { Pop-Location }
