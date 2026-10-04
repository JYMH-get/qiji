$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRealBefore = @(Get-ChildItem "$taskRoot/server/data" -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
foreach ($taskScenario in @('existing', 'fresh')) {
  $taskSandbox = Join-Path ([IO.Path]::GetTempPath()) ('qiji-xingguang-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path "$taskSandbox/src", "$taskSandbox/server/scripts", "$taskSandbox/server/data" -Force | Out-Null
  Copy-Item -LiteralPath "$taskRoot/src/contract.ts" -Destination "$taskSandbox/src/contract.ts"
  Copy-Item -LiteralPath "$taskRoot/server/src", "$taskRoot/server/skills" -Destination "$taskSandbox/server" -Recurse
  Copy-Item -LiteralPath "$taskRoot/server/package.json" -Destination "$taskSandbox/server"
  Copy-Item -LiteralPath "$taskRoot/server/scripts/smoke-xingguang.mjs" -Destination "$taskSandbox/server/scripts"
  Copy-Item -LiteralPath "$taskRoot/outputs/xingguang-20260928/models.json" -Destination "$taskSandbox/server/live-models.json"
  if ($taskScenario -eq 'existing') { Copy-Item -Path "$taskRoot/server/data/*.json" -Destination "$taskSandbox/server/data" }
  New-Item -ItemType Junction -Path "$taskSandbox/server/node_modules" -Target "$taskRoot/server/node_modules" | Out-Null
  [IO.File]::WriteAllText("$taskSandbox/server/.qiji-xingguang-sandbox", 'isolated; fetch mocked; no env copied')
  Push-Location "$taskSandbox/server"
  try {
    if ($taskScenario -eq 'existing') { & node -e "const fs=require('fs');fs.writeFileSync('retained.json',JSON.stringify(JSON.parse(fs.readFileSync('data/models.json')).models.filter(m=>m.channelId!=='ch-xingguang')));" }
    & node --import tsx scripts/smoke-xingguang.mjs seed
    if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
    $taskBefore = @(Get-ChildItem data -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
    & node -e "const fs=require('fs');const read=p=>JSON.parse(fs.readFileSync('data/'+p));fs.writeFileSync('xingguang-before.json',JSON.stringify({models:read('models.json').models.filter(m=>m.channelId==='ch-xingguang'),channel:read('channels.json').channels.find(m=>m.id==='ch-xingguang'),mode:read('modes.json').modes.find(m=>m.id==='xingguang'),family:read('families.json').families.find(m=>m.id==='fam-seedance')}));"
    & node --import tsx scripts/smoke-xingguang.mjs seed
    if ($LASTEXITCODE -ne 0) { throw 'second seed failed' }
    $taskAfter = @(Get-ChildItem data -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
    $taskDiff = Compare-Object $taskBefore $taskAfter -Property Path,Hash
    if ($taskDiff -and $taskScenario -eq 'existing') { throw 'second startup changed data' }
    & node -e "const fs=require('fs'),assert=require('assert/strict');const read=p=>JSON.parse(fs.readFileSync('data/'+p));assert.deepEqual({models:read('models.json').models.filter(m=>m.channelId==='ch-xingguang'),channel:read('channels.json').channels.find(m=>m.id==='ch-xingguang'),mode:read('modes.json').modes.find(m=>m.id==='xingguang'),family:read('families.json').families.find(m=>m.id==='fam-seedance')},JSON.parse(fs.readFileSync('xingguang-before.json')));"
    if ($LASTEXITCODE -ne 0) { throw 'Xingguang second startup changed data' }
    if ($taskScenario -eq 'existing') {
      & node --import tsx scripts/smoke-xingguang.mjs full
      if ($LASTEXITCODE -ne 0) { throw 'protocol checks failed' }
    }
    if ($taskDiff) { Write-Output "FRESH_LEGACY_MIGRATIONS_CHANGED: $((($taskDiff.Path | Sort-Object -Unique) | Split-Path -Leaf) -join ','); Xingguang entries unchanged" }
    Write-Output "XINGGUANG_ENTRIES_IDEMPOTENT; SCENARIO=$taskScenario; ALL_JSON_UNCHANGED=$(-not [bool]$taskDiff); JSON_COUNT=$($taskAfter.Count); SANDBOX=$taskSandbox"
  } finally { Pop-Location }
}
$taskRealAfter = @(Get-ChildItem "$taskRoot/server/data" -File -Filter '*.json' | Get-FileHash | Select-Object Path,Hash)
if (Compare-Object $taskRealBefore $taskRealAfter -Property Path,Hash) { throw 'real data changed' }
Write-Output 'REAL_JSON_UNCHANGED; zero paid generation requests'
