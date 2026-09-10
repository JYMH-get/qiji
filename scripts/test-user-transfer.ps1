$ErrorActionPreference = 'Stop'
$transferRoot = Split-Path -Parent $PSScriptRoot
$transferSandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-user-transfer-' + [guid]::NewGuid().ToString('N'))
$transferSourceData = Join-Path $transferRoot 'server/data'
$transferBefore = @(Get-ChildItem -LiteralPath $transferSourceData -File -Recurse | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Select-Object Path, Hash)
New-Item -ItemType Directory -Path "$transferSandbox/src", "$transferSandbox/server/scripts" -Force | Out-Null
Copy-Item -LiteralPath "$transferRoot/src/contract.ts" -Destination "$transferSandbox/src/contract.ts"
Copy-Item -LiteralPath "$transferRoot/server/src", "$transferRoot/server/skills" -Destination "$transferSandbox/server" -Recurse
Copy-Item -LiteralPath "$transferRoot/server/package.json", "$transferRoot/server/tsconfig.json" -Destination "$transferSandbox/server"
Copy-Item -LiteralPath "$transferRoot/server/scripts/smoke-user-transfer.mjs" -Destination "$transferSandbox/server/scripts"
Copy-Item -LiteralPath "$transferRoot/server/scripts/verify-user-transfer.mjs" -Destination "$transferSandbox/server/scripts"
if (Test-Path -LiteralPath "$transferRoot/server/scripts/smoke-transfer-scope.mjs") {
    Copy-Item -LiteralPath "$transferRoot/server/scripts/smoke-transfer-scope.mjs" -Destination "$transferSandbox/server/scripts"
}
New-Item -ItemType Junction -Path "$transferSandbox/server/node_modules" -Target "$transferRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$transferSandbox/server/.qiji-user-transfer-sandbox", 'Isolated synthetic data, no production .env or data copied.')
Write-Output "USER_TRANSFER_SANDBOX=$transferSandbox"
Push-Location "$transferSandbox/server"
try {
    & node --import tsx scripts/smoke-user-transfer.mjs
    if ($LASTEXITCODE -ne 0) { throw 'User migration smoke failed' }
    & node --import tsx scripts/verify-user-transfer.mjs
    if ($LASTEXITCODE -ne 0) { throw 'User migration restart verification failed' }
    if (Test-Path -LiteralPath scripts/smoke-transfer-scope.mjs) {
        & node --import tsx scripts/smoke-transfer-scope.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Migration catalog and generation scope smoke failed' }
    }
} finally {
    Pop-Location
    $transferAfter = @(Get-ChildItem -LiteralPath $transferSourceData -File -Recurse | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Select-Object Path, Hash)
    if ((ConvertTo-Json -InputObject $transferBefore -Compress) -cne (ConvertTo-Json -InputObject $transferAfter -Compress)) { throw 'Real source data changed during sandbox smoke' }
    Write-Output "USER_TRANSFER_SOURCE_DATA_UNCHANGED=$($transferAfter.Count) files; sandbox retained at $transferSandbox"
}
