# scripts/setup-windows.ps1 - Cài đặt môi trường phát triển Axiom trên Windows
# Chạy trong PowerShell: .\scripts\setup-windows.ps1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "     Axiom Windows Environment Setup      " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Kiểm tra Node.js
Write-Host "`n[1/5] Kiểm tra Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node -v
    Write-Host "  Node.js version: $nodeVersion" -ForegroundColor Green
    $major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
    if ($major -lt 22) {
        Write-Warning "Axiom yêu cầu Node >= 22. Hiện tại: $nodeVersion. Vui lòng cập nhật Node.js!"
    }
} catch {
    Write-Error "Không tìm thấy Node.js trên PATH. Vui lòng cài đặt Node.js >= 22 từ https://nodejs.org/"
}

# 2. Kiểm tra Python
Write-Host "`n[2/5] Kiểm tra Python..." -ForegroundColor Yellow
$pyCmd = $null
foreach ($cmd in @("python", "py -3", "python3")) {
    try {
        $out = & ($cmd.Split()[0]) ($cmd.Split()[1..($cmd.Split().Length-1)]) --version 2>&1
        if ($LASTEXITCODE -eq 0 -and $out -match "Python 3") {
            $pyCmd = $cmd
            Write-Host "  Tìm thấy: $out (lệnh: $cmd)" -ForegroundColor Green
            break
        }
    } catch {}
}

if (-not $pyCmd) {
    Write-Error "Không tìm thấy Python 3 trên hệ thống. Vui lòng cài đặt Python >= 3.10 từ https://www.python.org/downloads/ hoặc Microsoft Store."
}

# 3. Tạo virtual environment ~/.axiom/venv
Write-Host "`n[3/5] Thiết lập virtual environment tại ~/.axiom/venv..." -ForegroundColor Yellow
$axiomHome = Join-Path $HOME ".axiom"
$venvPath = Join-Path $axiomHome "venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"

if (-not (Test-Path $axiomHome)) {
    New-Item -ItemType Directory -Path $axiomHome -Force | Out-Null
}

if (-not (Test-Path $venvPython)) {
    Write-Host "  Đang tạo venv: $venvPath..." -ForegroundColor Gray
    $pyParts = $pyCmd.Split()
    & $pyParts[0] $pyParts[1..($pyParts.Length-1)] -m venv $venvPath
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Tạo virtualenv thất bại!"
    }
    Write-Host "  Đã tạo venv thành công!" -ForegroundColor Green
} else {
    Write-Host "  Venv đã tồn tại tại $venvPath" -ForegroundColor Green
}

# 4. Cài đặt pytest vào venv
Write-Host "`n[4/5] Cài đặt pytest vào venv..." -ForegroundColor Yellow
& $venvPython -m pip install --upgrade pip pytest > $null 2>&1
$pytestVer = & $venvPython -m pytest --version 2>&1
Write-Host "  Pytest version: $pytestVer" -ForegroundColor Green

# 5. Cấu hình Git hooks
Write-Host "`n[5/5] Cấu hình Git hooks..." -ForegroundColor Yellow
git config core.hooksPath .githooks
Write-Host "  Đã cấu hình core.hooksPath = .githooks" -ForegroundColor Green

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "         CÀI ĐẶT HOÀN TẤT THÀNH CÔNG!     " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "`nCách chạy kiểm tra CI trên Windows:" -ForegroundColor White
Write-Host "  1. Nếu dùng Git Bash:        ./scripts/ci-local.sh" -ForegroundColor Gray
Write-Host "  2. Nếu dùng PowerShell:      .\scripts\ci-local.ps1" -ForegroundColor Gray
Write-Host "  3. Chạy unit test thông thường: npm test" -ForegroundColor Gray
Write-Host "`nGhi chú về Sandbox:" -ForegroundColor White
Write-Host "  - Native Windows: Chạy chế độ local execution an toàn qua AXIOM_ALLOW_LOCAL_TESTS=1." -ForegroundColor Gray
Write-Host "  - WSL2 (Tùy chọn): Để có cách ly bwrap 100% như máy eval Linux, gõ 'wsl' trong thư mục repo." -ForegroundColor Gray
