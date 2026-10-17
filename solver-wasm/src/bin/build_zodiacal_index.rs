use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

use astro_wasm_solver::build_catalog_index;

fn main() {
    if let Err(error) = run() {
        eprintln!("Failed to build the Zodiacal index: {error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let input = PathBuf::from(
        arguments
            .next()
            .unwrap_or_else(|| "catalogs/zodiacal-stars.bin".into()),
    );
    let output = PathBuf::from(
        arguments
            .next()
            .unwrap_or_else(|| "catalogs/zodiacal-index.zdcl".into()),
    );
    if arguments.next().is_some() {
        return Err("usage: build_zodiacal_index [star-catalog.bin] [index.zdcl]".into());
    }

    let catalog_bytes = fs::read(&input)?;
    if catalog_bytes.is_empty() || catalog_bytes.len() % 16 != 0 {
        return Err(format!("invalid Float32 star catalog: {}", input.display()).into());
    }
    let stars = catalog_bytes
        .chunks_exact(4)
        .map(|value| f32::from_le_bytes(value.try_into().unwrap()))
        .collect::<Vec<_>>();

    let started = std::time::Instant::now();
    let index = build_catalog_index(&stars).map_err(std::io::Error::other)?;
    if let Some(parent) = output.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    index.save(&output)?;

    println!(
        "Wrote {} stars and {} quads to {} ({} bytes) in {:.2}s.",
        index.stars.len(),
        index.quads.len(),
        output.display(),
        fs::metadata(&output)?.len(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}
