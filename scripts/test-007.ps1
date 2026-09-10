$ErrorActionPreference = 'Stop'
$task007Root = Split-Path -Parent $PSScriptRoot
$task007Sandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-007-test-' + [guid]::NewGuid().ToString('N'))
$task007SourceData = Join-Path $task007Root 'server/data'
$task007Before = @(if (Test-Path -LiteralPath $task007SourceData) { Get-ChildItem -LiteralPath $task007SourceData -File -Recurse | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Select-Object Path, Hash })
New-Item -ItemType Directory -Path "$task007Sandbox/src", "$task007Sandbox/server/scripts" -Force | Out-Null
Copy-Item -LiteralPath "$task007Root/src/contract.ts" -Destination "$task007Sandbox/src/contract.ts"
Copy-Item -LiteralPath "$task007Root/server/src", "$task007Root/server/skills" -Destination "$task007Sandbox/server" -Recurse
Copy-Item -LiteralPath "$task007Root/server/package.json", "$task007Root/server/tsconfig.json" -Destination "$task007Sandbox/server"
Copy-Item -LiteralPath "$task007Root/server/scripts/smoke-007.mjs" -Destination "$task007Sandbox/server/scripts/smoke-007.mjs"
Copy-Item -LiteralPath "$task007Root/server/scripts/fixture-007.mjs" -Destination "$task007Sandbox/server/scripts/fixture-007.mjs"
New-Item -ItemType Junction -Path "$task007Sandbox/server/node_modules" -Target "$task007Root/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$task007Sandbox/server/.qiji-007-sandbox", 'Isolated generated fixture; no real .env or data copied.')
Write-Output "007_SANDBOX=$task007Sandbox"
Push-Location "$task007Sandbox/server"
try {
    & node --import tsx scripts/smoke-007.mjs seed
    if ($LASTEXITCODE -ne 0) { throw '007 first seed startup failed' }
    Copy-Item -LiteralPath "$task007Sandbox/server/data" -Destination "$task007Sandbox/first-start-data" -Recurse
    # Existing models.ts initializes historical migration flags only on the next cold start.
    & node --import tsx scripts/smoke-007.mjs seed
    if ($LASTEXITCODE -ne 0) { throw '007 legacy fixture bootstrap failed' }
    & node scripts/fixture-007.mjs
    if ($LASTEXITCODE -ne 0) { throw '007 existing-install fixture failed' }
    & node --import tsx scripts/smoke-007.mjs seed
    if ($LASTEXITCODE -ne 0) { throw '007 upgrade first startup failed' }
    $task007First = @(Get-ChildItem -LiteralPath "$task007Sandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    & node --import tsx scripts/smoke-007.mjs seed
    if ($LASTEXITCODE -ne 0) { throw '007 upgrade second startup failed' }
    $task007Second = @(Get-ChildItem -LiteralPath "$task007Sandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    $task007Delta = @(Compare-Object $task007First $task007Second -Property Path, Hash)
    if ($task007Delta.Count) { $task007Delta | Select-Object Path, SideIndicator | Format-Table; throw 'Seed second startup changed JSON data' }
    Write-Output "007_SECOND_START_IDEMPOTENT=$($task007Second.Count) JSON files unchanged"
    & node --import tsx scripts/smoke-007.mjs full
    if ($LASTEXITCODE -ne 0) { throw '007 protocol smoke failed' }
    & node --import tsx scripts/smoke-007.mjs tombstones
    if ($LASTEXITCODE -ne 0) { throw '007 tombstone restart failed' }
    $task007TombstonesFirst = @(Get-ChildItem -LiteralPath "$task007Sandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    & node --import tsx scripts/smoke-007.mjs tombstones
    if ($LASTEXITCODE -ne 0) { throw '007 tombstone second restart failed' }
    $task007TombstonesSecond = @(Get-ChildItem -LiteralPath "$task007Sandbox/server/data" -File -Filter '*.json' | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash)
    if (Compare-Object $task007TombstonesFirst $task007TombstonesSecond -Property Path, Hash) { throw '007 tombstone second startup changed JSON data' }
    Write-Output "007_TOMBSTONE_SECOND_START_IDEMPOTENT=$($task007TombstonesSecond.Count) JSON files unchanged"
} finally {
    Pop-Location
    $task007After = @(if (Test-Path -LiteralPath $task007SourceData) { Get-ChildItem -LiteralPath $task007SourceData -File -Recurse | Get-FileHash -Algorithm SHA256 | Sort-Object Path | Select-Object Path, Hash })
    if ((ConvertTo-Json -InputObject $task007Before -Compress) -cne (ConvertTo-Json -InputObject $task007After -Compress)) { throw 'Source data changed during smoke' }
    Write-Output "007_SOURCE_DATA_UNCHANGED=$($task007After.Count) files at $task007SourceData; sandbox retained at $task007Sandbox"
}
