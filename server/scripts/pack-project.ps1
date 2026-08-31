# Qiji full-project migration packer (source only).
# Produces qiji-project.tgz for continuing development on another machine.
#
# INCLUDES: all source + config (client / server / src-tauri), lock files, skills, .env.example
# EXCLUDES:
#   - dependencies / build output: node_modules (x2), src-tauri/target, src-tauri/gen, dist
#   - secrets / runtime state:     server/.env, server/data
#   - legacy agent runtime:         .git, .claude
#   - deploy/build artifacts:      _deploy, _migrate, *.tgz, *.zip, *.log
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "E:\Kaifa\Qiji\qiji\server\scripts\pack-project.ps1"
#
# On the new machine: extract, then  npm install  (root) and  cd server && npm install

$root  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$stage = Join-Path $root "_migrate"
$tgz   = Join-Path $root "qiji-project.tgz"

Write-Host "Project root: $root"

Remove-Item $stage, $tgz -Recurse -Force -ErrorAction SilentlyContinue

# Directories to exclude (full paths -> only these exact dirs; node_modules by name -> both root & server)
$xd = @(
  "node_modules",
  (Join-Path $root "src-tauri\target"),
  (Join-Path $root "src-tauri\gen"),
  (Join-Path $root "dist"),
  (Join-Path $root ".git"),
  (Join-Path $root ".claude"),
  (Join-Path $root "server\data"),
  (Join-Path $root "_deploy"),
  (Join-Path $root "_migrate")
)
# Files to exclude by name/pattern
$xf = @("*.log", "*.tgz", "*.zip")

robocopy $root $stage /E /XD $xd /XF $xf | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

# Belt-and-suspenders: robocopy /XF is unreliable for dotfiles, remove secrets explicitly
Remove-Item (Join-Path $stage ".env")        -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage "server\.env") -Force -ErrorAction SilentlyContinue

tar -czf $tgz -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$sizeMB = [math]::Round((Get-Item $tgz).Length / 1MB, 1)
Write-Host ""
Write-Host "OK -> $tgz ($sizeMB MB)"
Write-Host "New machine: extract, then 'npm install' at root and 'cd server && npm install'"
