$ErrorActionPreference = 'Stop'
$tasklongyouRoot = Split-Path -Parent $PSScriptRoot
$tasklongyouSandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-longyou-test-' + [guid]::NewGuid().ToString('N'))
$tasklongyouSourceData = Join-Path $tasklongyouRoot 'server/data'
$tasklongyouBefore = @(if (Test-Path -LiteralPath $tasklongyouSourceData) { Get-ChildItem -LiteralPath $tasklongyouSourceData -File -Recurse | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Select-Object Path, Hash })
New-Item -ItemType Directory -Path "$tasklongyouSandbox/src", "$tasklongyouSandbox/server/scripts" -Force | Out-Null
Copy-Item -LiteralPath "$tasklongyouRoot/src/contract.ts" -Destination "$tasklongyouSandbox/src/contract.ts"
Copy-Item -LiteralPath "$tasklongyouRoot/server/src", "$tasklongyouRoot/server/skills" -Destination "$tasklongyouSandbox/server" -Recurse
Copy-Item -LiteralPath "$tasklongyouRoot/server/package.json", "$tasklongyouRoot/server/tsconfig.json" -Destination "$tasklongyouSandbox/server"
Copy-Item -LiteralPath "$tasklongyouRoot/server/scripts/smoke-longyou.mjs" -Destination "$tasklongyouSandbox/server/scripts/smoke-longyou.mjs"

New-Item -ItemType Junction -Path "$tasklongyouSandbox/server/node_modules" -Target "$tasklongyouRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$tasklongyouSandbox/server/.qiji-longyou-sandbox", 'Isolated generated fixture; no real .env or data copied.')
Write-Output "longyou_SANDBOX=$tasklongyouSandbox"
Push-Location "$tasklongyouSandbox/server"
try {
    & node --import tsx scripts/smoke-longyou.mjs seed
    if ($LASTEXITCODE -ne 0) { throw 'longyou first seed startup failed' }
    Copy-Item -LiteralPath "$tasklongyouSandbox/server/data" -Destination "$tasklongyouSandbox/first-start-data" -Recurse
    # Existing models.ts initializes historical migration flags only on the next cold start.
    & node --import tsx scripts/smoke-longyou.mjs seed
    if ($LASTEXITCODE -ne 0) { throw 'longyou legacy fixture bootstrap failed' }
    & node --import tsx scripts/smoke-longyou.mjs fixture
    if ($LASTEXITCODE -ne 0) { throw 'longyou existing-install fixture failed' }
    & node --import tsx scripts/smoke-longyou.mjs seed
    if ($LASTEXITCODE -ne 0) { throw 'longyou upgrade first startup failed' }
    $tasklongyouFirst = @(Get-ChildItem -LiteralPath "$tasklongyouSandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    & node --import tsx scripts/smoke-longyou.mjs seed
    if ($LASTEXITCODE -ne 0) { throw 'longyou upgrade second startup failed' }
    $tasklongyouSecond = @(Get-ChildItem -LiteralPath "$tasklongyouSandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    $tasklongyouDelta = @(Compare-Object $tasklongyouFirst $tasklongyouSecond -Property Path, Hash)
    if ($tasklongyouDelta.Count) { $tasklongyouDelta | Select-Object Path, SideIndicator | Format-Table; throw 'Seed second startup changed JSON data' }
    Write-Output "longyou_SECOND_START_IDEMPOTENT=$($tasklongyouSecond.Count) JSON files unchanged"
    & node --import tsx scripts/smoke-longyou.mjs full
    if ($LASTEXITCODE -ne 0) { throw 'longyou protocol smoke failed' }
    & node --import tsx scripts/smoke-longyou.mjs tombstones
    if ($LASTEXITCODE -ne 0) { throw 'longyou tombstone restart failed' }
    $tasklongyouTombstonesFirst = @(Get-ChildItem -LiteralPath "$tasklongyouSandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    & node --import tsx scripts/smoke-longyou.mjs tombstones
    if ($LASTEXITCODE -ne 0) { throw 'longyou tombstone second restart failed' }
    $tasklongyouTombstonesSecond = @(Get-ChildItem -LiteralPath "$tasklongyouSandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    if (Compare-Object $tasklongyouTombstonesFirst $tasklongyouTombstonesSecond -Property Path, Hash) { throw 'longyou tombstone second startup changed JSON data' }
    Write-Output "longyou_TOMBSTONE_SECOND_START_IDEMPOTENT=$($tasklongyouTombstonesSecond.Count) JSON files unchanged"
} finally {
    Pop-Location
    $tasklongyouAfter = @(if (Test-Path -LiteralPath $tasklongyouSourceData) { Get-ChildItem -LiteralPath $tasklongyouSourceData -File -Recurse | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Select-Object Path, Hash })
    if ((ConvertTo-Json -InputObject $tasklongyouBefore -Compress) -cne (ConvertTo-Json -InputObject $tasklongyouAfter -Compress)) { throw 'Source data changed during smoke' }
    Write-Output "longyou_SOURCE_DATA_UNCHANGED=$($tasklongyouAfter.Count) files at $tasklongyouSourceData; sandbox retained at $tasklongyouSandbox"
}
