param([string]$SourceRoot)
$ErrorActionPreference = 'Stop'
$capabilityRoot = if ($SourceRoot) { (Resolve-Path -LiteralPath $SourceRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$capabilitySandbox = Join-Path $env:TEMP ('qiji-video-capabilities-' + [guid]::NewGuid().ToString('N'))
$capabilityFiles = @('models.json','channels.json','modes.json','families.json','auto-routing.json') | ForEach-Object { Join-Path $capabilityRoot "server/data/$_" } | Where-Object { Test-Path -LiteralPath $_ }
$capabilityBefore = @($capabilityFiles | ForEach-Object { Get-FileHash -LiteralPath $_ } | Select-Object Path,Hash)
New-Item -ItemType Directory -Path "$capabilitySandbox/src", "$capabilitySandbox/server/scripts" -Force | Out-Null
Copy-Item -LiteralPath "$capabilityRoot/src/contract.ts" -Destination "$capabilitySandbox/src/contract.ts"
Copy-Item -LiteralPath "$capabilityRoot/server/src", "$capabilityRoot/server/skills" -Destination "$capabilitySandbox/server" -Recurse
Copy-Item -LiteralPath "$capabilityRoot/server/package.json", "$capabilityRoot/server/tsconfig.json" -Destination "$capabilitySandbox/server"
Copy-Item -LiteralPath "$capabilityRoot/server/scripts/smoke-video-capabilities.mjs" -Destination "$capabilitySandbox/server/scripts"
New-Item -ItemType Junction -Path "$capabilitySandbox/server/node_modules" -Target "$capabilityRoot/server/node_modules" | Out-Null
[IO.File]::WriteAllText("$capabilitySandbox/server/.qiji-routing-sandbox", 'Fresh isolated database; no real credentials copied.')
Push-Location "$capabilitySandbox/server"
try {
    & node --import tsx scripts/smoke-video-capabilities.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Video capability smoke failed' }
} finally {
    Pop-Location
    $capabilityAfter = @($capabilityFiles | ForEach-Object { Get-FileHash -LiteralPath $_ } | Select-Object Path,Hash)
    if ((ConvertTo-Json -InputObject $capabilityBefore -Compress) -cne (ConvertTo-Json -InputObject $capabilityAfter -Compress)) { throw 'Source configuration changed during sandbox smoke' }
    Write-Output "CAPABILITY_SANDBOX=$capabilitySandbox; source configuration unchanged"
}
