$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$expectedWasmBindgenVersion = '0.2.129'
$scoopCargoHome = Join-Path $HOME 'scoop\persist\rustup-msvc\.cargo'
if (-not $env:CARGO_HOME -and (Test-Path (Join-Path $scoopCargoHome 'bin\cargo.exe'))) {
    $env:CARGO_HOME = $scoopCargoHome
    $env:RUSTUP_HOME = Join-Path $HOME 'scoop\persist\rustup-msvc\.rustup'
}
if ($env:CARGO_HOME) {
    $env:Path = "$(Join-Path $env:CARGO_HOME 'bin');$env:Path"
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    throw 'Rust Cargo is required. Install Rust and add Cargo to PATH.'
}

$wasmBindgen = Get-Command wasm-bindgen -ErrorAction SilentlyContinue
if (-not $wasmBindgen) {
    throw "wasm-bindgen CLI is required. Install version $expectedWasmBindgenVersion with cargo install wasm-bindgen-cli --version $expectedWasmBindgenVersion --locked."
}

$wasmBindgenVersion = (& wasm-bindgen --version).Trim()
if ($wasmBindgenVersion -ne "wasm-bindgen $expectedWasmBindgenVersion") {
    throw "Expected wasm-bindgen $expectedWasmBindgenVersion, found '$wasmBindgenVersion'."
}

Push-Location $repositoryRoot
try {
    & cargo build --locked --manifest-path solver-wasm/Cargo.toml --target wasm32-unknown-unknown --release
    if ($LASTEXITCODE -ne 0) {
        throw "Cargo WebAssembly build failed with exit code $LASTEXITCODE."
    }

    New-Item -ItemType Directory -Force -Path wasm/zodiacal | Out-Null
    & wasm-bindgen --target no-modules --out-dir wasm/zodiacal --out-name solver solver-wasm/target/wasm32-unknown-unknown/release/astro_wasm_solver.wasm
    if ($LASTEXITCODE -ne 0) {
        throw "wasm-bindgen failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
