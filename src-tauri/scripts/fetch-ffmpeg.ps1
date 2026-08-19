# 拉取并内置 Windows 版 ffmpeg.exe 到 src-tauri/resources/ffmpeg/ffmpeg.exe
# 该二进制随 Tauri 打包进应用（bundle.resources），供「视频结果截取」原生调用。
# 因体积约 97MB 不入 git，克隆后或换机时运行本脚本一次即可。
#   用法：powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # = src-tauri
$dest = Join-Path $root 'resources\ffmpeg'
$exe  = Join-Path $dest 'ffmpeg.exe'
if (Test-Path $exe) { Write-Host "已存在：$exe（删除后重跑可更新）"; exit 0 }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$zip = Join-Path $env:TEMP ("ffmpeg-fetch-{0}.zip" -f ([guid]::NewGuid().ToString('N')))
Write-Host "下载 ffmpeg…（约 90MB）"
Invoke-WebRequest -Uri $url -OutFile $zip
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
$entry = $z.Entries | Where-Object { $_.FullName -match 'bin/ffmpeg\.exe$' } | Select-Object -First 1
if (-not $entry) { $z.Dispose(); Remove-Item $zip -Force; throw '压缩包内未找到 bin/ffmpeg.exe' }
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $exe, $true)
$z.Dispose(); Remove-Item $zip -Force
Write-Host "完成：$exe"
