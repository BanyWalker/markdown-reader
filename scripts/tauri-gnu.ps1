[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'build')]
  [string]$Mode
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolchainBin = Join-Path $projectRoot '.tools\llvm-mingw-20260826-ucrt-x86_64\bin'
$compiler = Join-Path $toolchainBin 'x86_64-w64-mingw32-gcc.exe'
$archiver = Join-Path $toolchainBin 'x86_64-w64-mingw32-ar.exe'
$libraryDirectory = Join-Path $projectRoot '.tools\llvm-mingw-20260826-ucrt-x86_64\x86_64-w64-mingw32\lib'
$unwindLibrary = Join-Path $libraryDirectory 'libunwind.a'
$gccLibrary = Join-Path $libraryDirectory 'libgcc.a'
$gccExceptionLibrary = Join-Path $libraryDirectory 'libgcc_eh.a'

if (-not (Test-Path -LiteralPath $compiler) -or -not (Test-Path -LiteralPath $archiver) -or -not (Test-Path -LiteralPath $unwindLibrary)) {
  throw 'LLVM-MinGW is missing. Prepare the project toolchain or install Visual Studio Build Tools with C++.'
}

if (-not (Test-Path -LiteralPath $gccLibrary)) {
  & $archiver rcs $gccLibrary
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to prepare the LLVM-MinGW compatibility library.'
  }
}

Copy-Item -LiteralPath $unwindLibrary -Destination $gccExceptionLibrary -Force

$env:Path = "$toolchainBin;$env:USERPROFILE\.cargo\bin;$env:Path"
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
if ($Mode -eq 'dev') {
  $env:RUSTFLAGS = '-C link-arg=-Wl,--exclude-all-symbols'
}

Push-Location $projectRoot
try {
  & npx tauri $Mode
  $tauriExitCode = $LASTEXITCODE
  if ($Mode -eq 'build' -and $tauriExitCode -eq 0) {
    $bundleDirectory = Join-Path $projectRoot 'src-tauri\target\release\bundle\nsis'
    $installer = Get-ChildItem -LiteralPath $bundleDirectory -Filter '*_x64-setup.exe' -File |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($null -ne $installer) {
      $releaseDirectory = Join-Path $projectRoot 'release'
      New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
      $latestInstaller = Join-Path $releaseDirectory 'MD-Reader-latest-x64-setup.exe'
      Copy-Item -LiteralPath $installer.FullName -Destination $latestInstaller -Force
      Write-Host "Copied latest installer to: $latestInstaller"
    }
  }
  exit $tauriExitCode
} finally {
  Pop-Location
}
