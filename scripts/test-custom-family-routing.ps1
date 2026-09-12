$ErrorActionPreference = 'Stop'
$taskcustomfamilyRoot = Split-Path -Parent $PSScriptRoot
$taskcustomfamilySandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-customfamily-test-' + [guid]::NewGuid().ToString('N'))
$taskcustomfamilySourceData = Join-Path $taskcustomfamilyRoot 'server/data'
New-Item -ItemType Directory -Path "$taskcustomfamilySandbox/src", "$taskcustomfamilySandbox/server/scripts" -Force | Out-Null
Copy-Item -LiteralPath "$taskcustomfamilyRoot/src/contract.ts" -Destination "$taskcustomfamilySandbox/src/contract.ts"
Copy-Item -LiteralPath "$taskcustomfamilyRoot/server/src", "$taskcustomfamilyRoot/server/skills" -Destination "$taskcustomfamilySandbox/server" -Recurse
Copy-Item -LiteralPath "$taskcustomfamilyRoot/server/package.json", "$taskcustomfamilyRoot/server/tsconfig.json" -Destination "$taskcustomfamilySandbox/server"
Copy-Item -LiteralPath "$taskcustomfamilyRoot/server/scripts/smoke-custom-family-routing.mjs" -Destination "$taskcustomfamilySandbox/server/scripts/smoke-custom-family-routing.mjs"

New-Item -ItemType Junction -Path "$taskcustomfamilySandbox/server/node_modules" -Target "$taskcustomfamilyRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$taskcustomfamilySandbox/server/.qiji-custom-family-sandbox", 'Isolated generated fixture; no real .env or data copied.')
Push-Location "$taskcustomfamilySandbox/server"
try {
    & node --import tsx scripts/smoke-custom-family-routing.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Custom family routing regression failed' }
} finally { Pop-Location }
