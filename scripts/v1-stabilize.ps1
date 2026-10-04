$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Assert-NativeSuccess {
    param([Parameter(Mandatory = $true)][string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

function Find-FileOnProcessPath {
    param([Parameter(Mandatory = $true)][string]$FileName)

    foreach ($entry in ($env:Path -split ';')) {
        $directory = $entry.Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($directory)) {
            continue
        }
        $candidate = Join-Path $directory $FileName
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

Write-Host "== Transcriber V1 stabilization check ==" -ForegroundColor Cyan
Write-Host "Project: $root"

# A running dev binary can lock target\debug\transcriber.exe and make Cargo fail
# with Access Denied on Windows. Stop only this app process before rebuilding.
Get-Process transcriber -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "`n[1/6] Installing aligned frontend dependencies..." -ForegroundColor Yellow
npm install
Assert-NativeSuccess "npm install"

Write-Host "`n[2/6] Resolving the pinned Rust dependency graph..." -ForegroundColor Yellow
cargo update --manifest-path ".\src-tauri\Cargo.toml"
Assert-NativeSuccess "cargo update"

Write-Host "`n[3/6] Verifying the Tauri runtime family..." -ForegroundColor Yellow
cargo tree --manifest-path ".\src-tauri\Cargo.toml" -i tauri-runtime
Assert-NativeSuccess "cargo tree -i tauri-runtime"
cargo tree --manifest-path ".\src-tauri\Cargo.toml" -i tauri-runtime-wry
Assert-NativeSuccess "cargo tree -i tauri-runtime-wry"

Write-Host "`n[4/6] Checking Rust..." -ForegroundColor Yellow
cargo check --manifest-path ".\src-tauri\Cargo.toml"
Assert-NativeSuccess "cargo check"

Write-Host "`n[5/6] Running Rust tests..." -ForegroundColor Yellow
cargo test --manifest-path ".\src-tauri\Cargo.toml"
Assert-NativeSuccess "cargo test"

Write-Host "`n[6/6] Building the frontend..." -ForegroundColor Yellow
npm run build
Assert-NativeSuccess "npm run build"

Write-Host "`nCUDA/cuDNN visibility:" -ForegroundColor Cyan
$cuda = Find-FileOnProcessPath "cudart64_13.dll"
$cudnn = Find-FileOnProcessPath "cudnn64_9.dll"

if ($cuda) {
    Write-Host "CUDA:  $cuda" -ForegroundColor Green
} else {
    Write-Warning "CUDA 13 runtime was not found on PATH. CUDA transcription/speaker detection may be unavailable."
}

if ($cudnn) {
    Write-Host "cuDNN: $cudnn" -ForegroundColor Green
} else {
    $installedCudnn = Get-ChildItem "C:\Program Files\NVIDIA\CUDNN" -Recurse -Filter "cudnn64_9.dll" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\bin\\' } |
        Select-Object -First 1

    if ($installedCudnn) {
        Write-Host "cuDNN installed (not on PATH): $($installedCudnn.FullName)" -ForegroundColor Yellow
        Write-Host "Transcriber will auto-discover the installed cuDNN runtime for Speaker Detection." -ForegroundColor Yellow
    } else {
        Write-Warning "cuDNN 9 was not found. Speaker Detection will automatically retry on CPU if CUDA initialization fails."
    }
}

Write-Host "`nAll V1 stabilization checks passed." -ForegroundColor Green
Write-Host "Start development mode with: npm run tauri dev"
Write-Host "When final validation is done, create the release installer with: npm run tauri build"
