#Requires -Version 5.1
<#
  One-shot release packer for pi-web (PowerShell).

  Flow: stop dev server (port 5566) → typecheck → lint → tests → build → npm pack
  Usage:  .\scripts\release-pack.ps1 [-SkipChecks]
  Params: -SkipChecks   skip tsc/lint/tests, only stop dev + build + pack
          -DevPort 5566 override the dev server port to stop
#>
[CmdletBinding()]
param(
  [switch]$SkipChecks,
  [int]$DevPort = 5566
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Fail($msg)  { Write-Host "!!  $msg" -ForegroundColor Red; exit 1 }

# ---- 1. stop the dev server on $DevPort (default 5566) -------
Write-Step "stopping dev server on port $DevPort"
$conn = Get-NetTCPConnection -LocalPort $DevPort -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
  Write-Ok "port $DevPort already free"
} else {
  $pids = $conn.OwningProcess | Sort-Object -Unique
  foreach ($pid0 in $pids) {
    Write-Step "killing PID $pid0 (port $DevPort)"
    Stop-Process -Id $pid0 -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Write-Ok "port $DevPort released"
}

# ---- 2. checks --------------------------------------------------------------
if (-not $SkipChecks) {
  Write-Step "typecheck (tsc --noEmit)"
  & node_modules/.bin/tsc.cmd --noEmit
  if ($LASTEXITCODE -ne 0) { Write-Fail "typecheck failed" }
  Write-Ok "typecheck passed"

  Write-Step "lint (eslint .)"
  npm run lint
  if ($LASTEXITCODE -ne 0) { Write-Fail "lint failed" }
  Write-Ok "lint passed"

  Write-Step "unit tests"
  npm test
  if ($LASTEXITCODE -ne 0) { Write-Fail "tests failed" }
  Write-Ok "tests passed"
} else {
  Write-Ok "checks skipped (-SkipChecks)"
}

# ---- 3. build ---------------------------------------------------------------
Write-Step "production build (next build --webpack)"
npm run build
if ($LASTEXITCODE -ne 0) { Write-Fail "build failed" }
Write-Ok "build passed"

# ---- 4. pack ----------------------------------------------------------------
Write-Step "npm pack"
  $packOut = cmd /c "npm pack 2>nul"
  $tgz = ($packOut | Select-Object -Last 1) -as [string]
if (-not $tgz.EndsWith(".tgz")) { Write-Fail "npm pack produced unexpected output: $tgz" }

$ver = node -p "require('./package.json').version"
$size = [math]::Round((Get-Item $tgz).Length / 1MB, 1)

Write-Host ""
Write-Host "PACKED: $tgz ($size MB, v$ver)" -ForegroundColor Green
Write-Host "install manually when ready: npm install -g ./$tgz" -ForegroundColor Green
Pop-Location
