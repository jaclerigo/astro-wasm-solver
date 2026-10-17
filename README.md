# Astro WASM Plate Solver

Astro WASM Plate Solver resolves an image in a browser Web Worker using the
Zodiacal Rust solver compiled to WebAssembly. WordPress receives only the
resulting coordinates, WCS, and projected deep-sky-object markers; it does not
process or upload the image pixels.

## Build the solver

Requirements: Rust with the `wasm32-unknown-unknown` target and the matching
`wasm-bindgen` CLI version 0.2.129. The Zodiacal Apache 2.0 license is
included at `licenses/Zodiacal-Apache-2.0.txt`.

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
.\tools\build-wasm.ps1
```

The build writes `solver.js`, `solver.d.ts`, and `solver_bg.wasm` to
`wasm/zodiacal/`. Deploy these files together with the
worker; the plugin references the generated wrapper and binary from that
directory.

## Build the browser catalogs

### Star catalog

The existing Astrometry.net FITS indexes contain selected stars, but their
native quad/tree data cannot be opened directly by Zodiacal. Generate the
compact Zodiacal input catalog with Python 3 and Astrometry.net's `query-starkd`
utility:

```powershell
python tools\export-zodiacal-catalog.py `
  catalogs\index-4209.fits catalogs\index-4210.fits catalogs\index-4211.fits `
  --query-starkd query-starkd `
  --output catalogs\zodiacal-stars.bin
```

The binary contains little-endian records of four Float32 values:
catalog ID, right ascension (radians), declination (radians), and J magnitude.
With the bundled input FITS files, the generated catalog contains 731,764
unique stars and is 11,708,224 bytes. Convert it to the serialized Zodiacal
index using the native Rust builder:

```powershell
cargo run --locked --release --manifest-path solver-wasm\Cargo.toml `
  --bin build_zodiacal_index -- `
  catalogs\zodiacal-stars.bin catalogs\zodiacal-index.zdcl
```

The checked-in prebuilt index contains 731,764 stars and 49,112 quads and is
25,773,872 bytes. The browser downloads and initializes this index once per
worker instead of constructing the quad index from the source catalog at
runtime. The index parser and synthetic full-sky solve are covered by the Rust
tests below; the Worker smoke test reports local initialization time and
indicative Node memory deltas. Those measurements are not a substitute for
browser/device and deployed HTTP-compression measurements. Each solve has a
15-second timeout and uses at most 16 extracted field stars; difficult fields
can therefore return an explicit timeout rather than an unbounded computation.

### Messier/NGC/IC object catalog

The bundled `catalogs/openngc/` data is from OpenNGC
([mattiaverga/OpenNGC](https://github.com/mattiaverga/OpenNGC)); its
`CC-BY-SA-4.0.txt` is included alongside the source CSV files. Generate the
compact object catalog with:

```powershell
python tools\export-openngc-catalog.py `
  catalogs\openngc\NGC.csv catalogs\openngc\addendum.csv `
  --output catalogs\openngc.json
```

The overlay catalog is derived from OpenNGC and is distributed under
CC BY-SA 4.0. It includes Messier, NGC, and IC designations and J2000
coordinates. The worker projects these coordinates through the solved TAN WCS
and sends only in-frame objects to the viewer. The bundled data currently
produces 12,601 records (about 1.07 MB).

## Runtime flow

1. The admin UI decodes the selected image into RGBA pixels locally.
2. The worker initializes Zodiacal and loads the prebuilt serialized star index
   locally; the image pixels remain in the browser.
3. The solver extracts image sources and returns a TAN WCS, or an explicit
   error if the image cannot be solved.
4. The worker projects the object catalog into image pixels.
5. WordPress stores solution metadata; the frontend draws pixel-coordinate
   markers and labels.

The AJAX endpoint persists the serialized WCS in `_astro_wcs` and the
projected objects in `_astro_objects`. The browser does not send image pixels
to WordPress.

## Validation

Run the Rust solver tests with:

```powershell
cargo test --locked --manifest-path solver-wasm/Cargo.toml --release
```

The default tests cover Zodiacal solving against a small synthetic star field,
extraction and solving from rendered RGBA pixels, explicit rejection of a
blank image, parsing of the prebuilt index, and a synthetic 3-degree full-sky
field around M15 solved against that index.

Build the generated WebAssembly assets and test the Worker/index initialization
and TAN overlay projection with:

```powershell
.\tools\build-wasm.ps1
node tools\test-wasm-worker.js
```

The 3599-by-2010 M15 JPEG has not yet produced an astrometric solution with the
full catalog. The previous `RuntimeError: unreachable` was specific to the Node
test harness lacking `self.performance`; with that browser Worker API present,
the solver returns `No astrometric solution found.` Real-image solving and
WordPress/browser end-to-end behavior therefore remain unvalidated.
