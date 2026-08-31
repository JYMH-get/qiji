[CmdletBinding()]
param(
    [switch]$SmokeTest,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverPort = 8787
$vitePort = 5173
$desktopExe = Join-Path $projectRoot 'src-tauri\target\debug\app.exe'
$children = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Stop-ProcessTree {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return }
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

function Stop-StaleQijiDevProcesses {
    $rootPattern = [regex]::Escape($projectRoot)
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -and
        (
            $_.CommandLine -match 'start-(server-dev|client-desktop)\.cmd' -or
            ($_.CommandLine -match $rootPattern -and $_.CommandLine -match '(tsx|vite)')
        )
    }

    foreach ($process in $processes) {
        Stop-ProcessTree -ProcessId ([int]$process.ProcessId)
    }

    Start-Sleep -Milliseconds 600
}

function Assert-PortAvailable {
    param(
        [int]$Port,
        [string]$ServiceName
    )

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        $command = if ($owner.CommandLine) { $owner.CommandLine } else { $owner.Name }
        throw "$ServiceName 端口 $Port 已被非本脚本进程占用（PID $($listener.OwningProcess)）：$command"
    }
}

function Start-QijiWindow {
    param(
        [string]$ScriptPath
    )

    if (-not (Test-Path -LiteralPath $ScriptPath)) {
        throw "启动辅助脚本不存在：$ScriptPath"
    }
    $process = Start-Process -FilePath $env:ComSpec `
        -ArgumentList @('/d', '/k', $ScriptPath) `
        -WorkingDirectory $projectRoot `
        -PassThru
    $children.Add($process)
    return $process
}

function Wait-HttpHealth {
    param(
        [string]$Uri,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastHealthResult = '尚未收到响应'
    do {
        try {
            $response = Invoke-RestMethod -Uri $Uri -TimeoutSec 10
            $lastHealthResult = $response | ConvertTo-Json -Compress
            if ($response.ok -eq $true) {
                return
            }
        } catch {
            $lastHealthResult = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 700
    } while ((Get-Date) -lt $deadline)

    throw "服务端健康检查超时：$Uri；最后结果：$lastHealthResult"
}

function Wait-TcpPort {
    param(
        [int]$Port,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $tcp = New-Object System.Net.Sockets.TcpClient
        try {
            $tcp.Connect('localhost', $Port)
            return
        } catch {
            Start-Sleep -Milliseconds 500
        } finally {
            $tcp.Dispose()
        }
    } while ((Get-Date) -lt $deadline)

    throw "客户端端口启动超时：http://localhost:$Port"
}

function Wait-DesktopClient {
    param([int]$TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $process = Get-CimInstance Win32_Process -Filter "Name='app.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -eq $desktopExe } |
            Select-Object -First 1
        if ($process) { return }
        Start-Sleep -Milliseconds 700
    } while ((Get-Date) -lt $deadline)

    throw "Tauri 桌面客户端启动超时：$desktopExe"
}

function Start-CloseWatchdog {
    param(
        [int]$ControllerPid,
        [int[]]$ChildPids
    )

    $pidList = ($ChildPids -join ',')
    $watchdog = @"
`$controller = $ControllerPid
`$children = @($pidList)
while (Get-Process -Id `$controller -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 500
}
foreach (`$child in `$children) {
    taskkill.exe /PID `$child /T /F 2>`$null | Out-Null
}
"@

    Start-Process -FilePath 'C:\Program Files\PowerShell\7\pwsh.exe' `
        -ArgumentList @('-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $watchdog) `
        -WindowStyle Hidden | Out-Null
}

try {
    Write-Host 'Qiji 开发环境启动中……' -ForegroundColor Cyan

    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'server\.env'))) {
        throw '缺少 server\.env，请先从 server\.env.example 创建并填写本机配置。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
        throw '缺少根目录 node_modules，请先执行 npm install。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'server\node_modules'))) {
        throw '缺少 server\node_modules，请先执行 npm --prefix server install。'
    }

    Stop-StaleQijiDevProcesses
    Assert-PortAvailable -Port $serverPort -ServiceName 'Qiji 服务端'
    Assert-PortAvailable -Port $vitePort -ServiceName 'Tauri 内部 Vite 服务'

    Write-Host "[1/3] 启动服务端：http://localhost:$serverPort" -ForegroundColor Yellow
    $server = Start-QijiWindow `
        -ScriptPath (Join-Path $PSScriptRoot 'start-server-dev.cmd')

    Wait-HttpHealth -Uri "http://localhost:$serverPort/health" -TimeoutSeconds 90
    Write-Host '[2/3] 服务端健康检查通过。' -ForegroundColor Green

    Write-Host '[3/3] 启动 Tauri 桌面客户端。' -ForegroundColor Yellow
    $client = Start-QijiWindow `
        -ScriptPath (Join-Path $PSScriptRoot 'start-client-desktop.cmd')

    Start-CloseWatchdog -ControllerPid $PID -ChildPids @($server.Id, $client.Id)
    Wait-TcpPort -Port $vitePort -TimeoutSeconds 60
    Wait-DesktopClient -TimeoutSeconds 180

    Write-Host ''
    Write-Host 'Qiji 开发环境已就绪：' -ForegroundColor Green
    Write-Host "  服务端管理页  http://localhost:$serverPort/admin"
    Write-Host '  客户端        Tauri 独立桌面窗口'
    Write-Host '关闭本控制窗口或按 Enter，两项服务都会自动关闭。' -ForegroundColor Cyan

    if (-not $NoBrowser -and -not $SmokeTest) {
        Start-Process "http://localhost:$serverPort/admin"
    }

    if (-not $SmokeTest) {
        Read-Host '按 Enter 停止开发环境' | Out-Null
    }
} finally {
    Write-Host ''
    Write-Host '正在关闭 Qiji 客户端与服务端……' -ForegroundColor Yellow
    for ($i = $children.Count - 1; $i -ge 0; $i--) {
        Stop-ProcessTree -ProcessId $children[$i].Id
    }
    Write-Host '两项服务已关闭。' -ForegroundColor Green
}
