# Qiji server deploy packer.
# Produces qiji-server-deploy.tgz (tar uses forward slashes -> extracts correctly on Linux,
# avoiding the backslash bug of Compress-Archive).
#
# Usage (run from anywhere; script resolves the project root itself):
#   powershell -ExecutionPolicy Bypass -File "E:\Kaifa\Qiji\qiji\server\scripts\pack-deploy.ps1"
#
# On the server, extract with:
#   tar xzf qiji-server-deploy.tgz -C /opt/qiji

# Project root = two levels up from this script (server\scripts\ -> root)
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$out  = Join-Path $root "_deploy"
$tgz  = Join-Path $root "qiji-server-deploy.tgz"

Write-Host "Project root: $root"

# Sanity check: the shared contract must exist
$contract = Join-Path $root "src\contract.ts"
if (-not (Test-Path $contract)) { throw "Missing $contract - is this script under server\scripts\ ?" }
$website = Join-Path $root "website"
if (-not (Test-Path (Join-Path $website "render.ts"))) { throw "Missing website/render.ts" }
if (-not (Test-Path (Join-Path $website "template\index.html"))) { throw "Missing website/template/index.html" }

# Clean old output
# Validate the exact workspace targets before recursive cleanup.
foreach ($target in @($out, $tgz)) {
    $resolvedTarget = [System.IO.Path]::GetFullPath($target)
    if ([System.IO.Path]::GetDirectoryName($resolvedTarget) -ne $root) { throw "Unsafe output path: $target" }
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Refusing linked output: $target" }
}
Remove-Item -LiteralPath $out, $tgz -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $out "src") | Out-Null

# 1) Shared contract (single file; server/src/contract.ts re-exports ../../src/contract at runtime)
Copy-Item $contract (Join-Path $out "src\contract.ts")

# 2) Server source (exclude node_modules / data / logs)
robocopy (Join-Path $root "server") (Join-Path $out "server") /E /XD node_modules data /XF *.log | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

# Drop the secrets file; keep .env.example (.env is maintained on the server)
Remove-Item (Join-Path $out "server\.env") -Force -ErrorAction SilentlyContinue

# Independent website sources needed by authenticated preview/export (never site.json or dist).
New-Item -ItemType Directory -Force (Join-Path $out "website") | Out-Null
Copy-Item (Join-Path $website "render.ts") (Join-Path $out "website\render.ts")
Copy-Item (Join-Path $website "template") (Join-Path $out "website\template") -Recurse

# 3) Deploy files
Copy-Item (Join-Path $root "docker-compose.yml") $out
Copy-Item (Join-Path $root ".dockerignore")      $out

# 4) Pack with the built-in Windows tar (bsdtar; forward slashes)
tar -czf $tgz -C $out .
if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }

# Remove intermediate folder
Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "OK -> $tgz"
Write-Host "Upload it, then on the server run: tar xzf qiji-server-deploy.tgz -C /opt/qiji"
