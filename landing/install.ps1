# CI Local Pro — Windows installer
# Usage: irm https://centralintelligence.online/install.ps1 | iex
$ErrorActionPreference = "Stop"

$VERSION = "0.1.0"
$REPO = "AlekseiMarchenko/ci-local-pro"
$INSTALL_DIR = "$env:USERPROFILE\.ci-local-pro"

Write-Host ""
Write-Host "  🧠 CI Local Pro v$VERSION" -ForegroundColor Cyan
Write-Host "  See what your AI actually remembers"
Write-Host ""

# Check Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js 18+ is required." -ForegroundColor Yellow
    Write-Host "  → Installing via winget..."
    try {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        $env:PATH = "$env:PROGRAMFILES\nodejs;$env:PATH"
    } catch {
        Write-Host "  ❌ Auto-install failed. Install manually: https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}

$nodeVer = (node -v) -replace 'v','' -split '\.' | Select-Object -First 1
if ([int]$nodeVer -lt 18) {
    Write-Host "  ❌ Node.js 18+ required (you have v$nodeVer)" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Node.js $(node -v)" -ForegroundColor Green

# Download
Write-Host "  → Downloading..."
$tarball = "https://github.com/$REPO/releases/download/v$VERSION/ci-local-pro-v$VERSION.tar.gz"

if (Test-Path $INSTALL_DIR) { Remove-Item -Recurse -Force $INSTALL_DIR }
New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null

try {
    $zipPath = "$env:TEMP\ci-local-pro.tar.gz"
    Invoke-WebRequest -Uri $tarball -OutFile $zipPath
    tar xzf $zipPath -C $INSTALL_DIR --strip-components=1
    Remove-Item $zipPath
} catch {
    Write-Host "  → Tarball unavailable, trying git clone..." -ForegroundColor DarkGray
    git clone --depth 1 "https://github.com/$REPO.git" $INSTALL_DIR 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ❌ Download failed." -ForegroundColor Red
        exit 1
    }
}

# Install dependencies
Write-Host "  → Installing dependencies..."
Set-Location $INSTALL_DIR
npm install --omit=dev --silent 2>$null

# Create launcher
$launcher = @"
@echo off
npx --yes tsx "%~dp0src\cli.ts" %*
"@
Set-Content -Path "$INSTALL_DIR\ci.cmd" -Value $launcher

# Add to PATH
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$INSTALL_DIR*") {
    [Environment]::SetEnvironmentVariable("PATH", "$INSTALL_DIR;$userPath", "User")
    $env:PATH = "$INSTALL_DIR;$env:PATH"
    Write-Host "  ✓ Added to PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "  ✅ CI Local Pro installed!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next:  ci dashboard"
Write-Host "  Open:  http://localhost:3141"
Write-Host ""
Write-Host "  Your AI memories are waiting."
Write-Host ""
