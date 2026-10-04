$ErrorActionPreference = 'Stop'
$materialRoot = Split-Path -Parent $PSScriptRoot
$materialSandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-official-materials-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$materialSandbox/src", "$materialSandbox/server/scripts" -Force | Out-Null
Copy-Item -LiteralPath "$materialRoot/src/contract.ts" -Destination "$materialSandbox/src/contract.ts"
Copy-Item -LiteralPath "$materialRoot/server/src", "$materialRoot/server/skills" -Destination "$materialSandbox/server" -Recurse
Copy-Item -LiteralPath "$materialRoot/server/package.json", "$materialRoot/server/tsconfig.json" -Destination "$materialSandbox/server"
Copy-Item -LiteralPath "$materialRoot/server/scripts/smoke-official-materials.mjs" -Destination "$materialSandbox/server/scripts/smoke-official-materials.mjs"
New-Item -ItemType Junction -Path "$materialSandbox/server/node_modules" -Target "$materialRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$materialSandbox/server/.qiji-official-materials-sandbox", 'No production or test data copied; outbound fetch is stubbed.')
Write-Output "OFFICIAL_MATERIALS_SANDBOX=$materialSandbox"
Push-Location "$materialSandbox/server"
try {
    & node --import tsx scripts/smoke-official-materials.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Official materials sandbox failed' }
    & node --import tsx scripts/smoke-official-materials.mjs restart
    if ($LASTEXITCODE -ne 0) { throw 'Official materials restart check failed' }
} finally { Pop-Location }
