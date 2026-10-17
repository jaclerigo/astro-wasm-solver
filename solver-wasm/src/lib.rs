use std::cell::RefCell;
use std::f64::consts::PI;
use std::time::Duration;

use ndarray::Array2;
use serde::Serialize;
use starfield::catalogs::{StarCatalog, StarData};
use starfield::Equatorial;
use wasm_bindgen::prelude::*;
use zodiacal::extraction::ExtractionConfig;
use zodiacal::index::{Index, IndexFragment, IndexMetadata, IndexStar};
use zodiacal::index::builder::{CatalogBuilderConfig, build_index_from_catalog};
use zodiacal::quads::{Code, DIMCODES, DIMQUADS, Quad};
use zodiacal::solver::{SolverConfig, solve};

thread_local! {
    static INDEX: RefCell<Option<Index>> = const { RefCell::new(None) };
}

const ARCSECONDS_PER_RADIAN: f64 = 180.0 * 3600.0 / PI;
const MAX_SOLVE_SECONDS: u64 = 15;

struct InMemoryCatalog(Vec<StarData>);

impl StarCatalog for InMemoryCatalog {
    type Star = StarData;

    fn get_star(&self, id: usize) -> Option<&Self::Star> {
        self.0.get(id)
    }

    fn stars(&self) -> impl Iterator<Item = &Self::Star> {
        self.0.iter()
    }

    fn len(&self) -> usize {
        self.0.len()
    }

    fn filter<F>(&self, predicate: F) -> Vec<&Self::Star>
    where
        F: Fn(&Self::Star) -> bool,
    {
        self.0.iter().filter(|star| predicate(star)).collect()
    }

    fn star_data(&self) -> impl Iterator<Item = StarData> + '_ {
        self.0.iter().copied()
    }

    fn filter_star_data<F>(&self, predicate: F) -> Vec<StarData>
    where
        F: Fn(&StarData) -> bool,
    {
        self.0.iter().copied().filter(predicate).collect()
    }
}

#[derive(Serialize)]
struct SolutionOutput {
    ra_deg: f64,
    dec_deg: f64,
    pixel_scale_arcsec: f64,
    rotation_deg: f64,
    width: u32,
    height: u32,
    wcs: zodiacal::geom::tan::TanWcs,
}

fn js_error(message: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&message.to_string())
}

/// Build a Zodiacal index from groups of [catalog ID, RA radians, Dec radians, magnitude].
#[wasm_bindgen]
pub fn initialize_catalog(stars: &[f32]) -> Result<(), JsValue> {
    initialize_catalog_inner(stars).map_err(js_error)
}

fn initialize_catalog_inner(stars: &[f32]) -> Result<(), String> {
    let index = build_catalog_index(stars)?;
    INDEX.with(|current| *current.borrow_mut() = Some(index));
    Ok(())
}

pub fn build_catalog_index(stars: &[f32]) -> Result<Index, String> {
    if stars.is_empty() || stars.len() % 4 != 0 {
        return Err("Star catalog must contain groups of four values.".to_string());
    }

    let mut catalog = Vec::with_capacity(stars.len() / 4);
    for star in stars.chunks_exact(4) {
        let id = f64::from(star[0]);
        let ra_rad = f64::from(star[1]);
        let dec_rad = f64::from(star[2]);
        let magnitude = f64::from(star[3]);
        if !id.is_finite()
            || id < 0.0
            || id.fract() != 0.0
            || id > u64::MAX as f64
            || !ra_rad.is_finite()
            || !dec_rad.is_finite()
            || !magnitude.is_finite()
            || !(-PI / 2.0..=PI / 2.0).contains(&dec_rad)
        {
            return Err("Star catalog contains an invalid record.".to_string());
        }

        catalog.push(StarData::with_position(
            id as u64,
            Equatorial::new(ra_rad, dec_rad),
            magnitude,
            None,
        ));
    }

    let config = CatalogBuilderConfig {
        scale_lower: (30.0 / ARCSECONDS_PER_RADIAN),
        scale_upper: (7200.0 / ARCSECONDS_PER_RADIAN),
        max_stars_per_cell: 64,
        max_quads: None,
        uniformize_depth: Some(6),
        quad_depth: None,
        passes: 16,
        max_reuse: 8,
    };
    Ok(build_index_from_catalog(&InMemoryCatalog(catalog), &config))
}

/// Load a prebuilt Zodiacal v2 index from bytes and reconstruct its search trees.
#[wasm_bindgen]
pub fn initialize_index(index_bytes: &[u8]) -> Result<(), JsValue> {
    let index = load_index_from_bytes(index_bytes).map_err(js_error)?;
    INDEX.with(|current| *current.borrow_mut() = Some(index));
    Ok(())
}

fn load_index_from_bytes(bytes: &[u8]) -> Result<Index, String> {
    const HEADER_SIZE: usize = 8 + 8 + 8 + 8 + 8 + 8;
    const STAR_RECORD_SIZE: usize = 32;
    const QUAD_RECORD_SIZE: usize = DIMQUADS * 4;
    const CODE_RECORD_SIZE: usize = DIMCODES * 8;

    if bytes.len() < HEADER_SIZE || &bytes[..4] != b"ZDCL" {
        return Err("Prebuilt index header is invalid.".to_string());
    }

    let mut cursor = 4;
    let version = read_u32(bytes, &mut cursor)?;
    if version != 2 {
        return Err(format!("Unsupported prebuilt index version: {version}."));
    }

    let metadata_len = usize::try_from(read_u64(bytes, &mut cursor)?)
        .map_err(|_| "Prebuilt index metadata exceeds supported limits.".to_string())?;
    let metadata_end = cursor
        .checked_add(metadata_len)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| "Prebuilt index metadata exceeds the file size.".to_string())?;
    let metadata = if metadata_len == 0 {
        None
    } else {
        Some(
            serde_json::from_slice::<IndexMetadata>(&bytes[cursor..metadata_end])
                .map_err(|error| format!("Prebuilt index metadata is invalid: {error}"))?,
        )
    };
    cursor = metadata_end;

    let star_count = usize::try_from(read_u64(bytes, &mut cursor)?)
        .map_err(|_| "Prebuilt index star count exceeds supported limits.".to_string())?;
    let quad_count = usize::try_from(read_u64(bytes, &mut cursor)?)
        .map_err(|_| "Prebuilt index quad count exceeds supported limits.".to_string())?;
    if star_count == 0 || star_count > u32::MAX as usize {
        return Err("Prebuilt index star count is invalid.".to_string());
    }

    let scale_lower = read_f64(bytes, &mut cursor)?;
    let scale_upper = read_f64(bytes, &mut cursor)?;
    if !scale_lower.is_finite()
        || !scale_upper.is_finite()
        || scale_lower <= 0.0
        || scale_upper <= scale_lower
    {
        return Err("Prebuilt index scale range is invalid.".to_string());
    }

    let stars_size = star_count
        .checked_mul(STAR_RECORD_SIZE)
        .ok_or_else(|| "Prebuilt index star block exceeds supported limits.".to_string())?;
    let quads_size = quad_count
        .checked_mul(QUAD_RECORD_SIZE)
        .ok_or_else(|| "Prebuilt index quad block exceeds supported limits.".to_string())?;
    let codes_size = quad_count
        .checked_mul(CODE_RECORD_SIZE)
        .ok_or_else(|| "Prebuilt index code block exceeds supported limits.".to_string())?;
    let expected_len = cursor
        .checked_add(stars_size)
        .and_then(|end| end.checked_add(quads_size))
        .and_then(|end| end.checked_add(codes_size))
        .ok_or_else(|| "Prebuilt index size exceeds supported limits.".to_string())?;
    if expected_len != bytes.len() {
        return Err("Prebuilt index data length does not match its header.".to_string());
    }

    let mut stars = Vec::with_capacity(star_count);
    for _ in 0..star_count {
        let catalog_id = read_u64(bytes, &mut cursor)?;
        let ra = read_f64(bytes, &mut cursor)?;
        let dec = read_f64(bytes, &mut cursor)?;
        let magnitude = read_f64(bytes, &mut cursor)?;
        if !ra.is_finite()
            || !(0.0..2.0 * PI).contains(&ra)
            || !dec.is_finite()
            || !(-PI / 2.0..=PI / 2.0).contains(&dec)
            || !magnitude.is_finite()
        {
            return Err("Prebuilt index contains an invalid star record.".to_string());
        }
        stars.push(IndexStar::without_pm(catalog_id, ra, dec, magnitude));
    }

    let mut quads = Vec::with_capacity(quad_count);
    for _ in 0..quad_count {
        let mut star_ids = [0; DIMQUADS];
        for star_id in &mut star_ids {
            *star_id = read_u32(bytes, &mut cursor)? as usize;
            if *star_id >= star_count {
                return Err("Prebuilt index quad references a missing star.".to_string());
            }
        }
        quads.push(Quad { star_ids });
    }

    let mut codes = Vec::<Code>::with_capacity(quad_count);
    for _ in 0..quad_count {
        let mut code = [0.0; DIMCODES];
        for coordinate in &mut code {
            *coordinate = read_f64(bytes, &mut cursor)?;
            if !coordinate.is_finite() {
                return Err("Prebuilt index contains an invalid quad code.".to_string());
            }
        }
        codes.push(code);
    }

    Ok(Index::from(IndexFragment {
        stars,
        quads,
        codes,
        scale_lower,
        scale_upper,
        metadata,
    }))
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, String> {
    let end = cursor
        .checked_add(4)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| "Prebuilt index is truncated.".to_string())?;
    let value = u32::from_le_bytes(bytes[*cursor..end].try_into().unwrap());
    *cursor = end;
    Ok(value)
}

fn read_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64, String> {
    let end = cursor
        .checked_add(8)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| "Prebuilt index is truncated.".to_string())?;
    let value = u64::from_le_bytes(bytes[*cursor..end].try_into().unwrap());
    *cursor = end;
    Ok(value)
}

fn read_f64(bytes: &[u8], cursor: &mut usize) -> Result<f64, String> {
    let end = cursor
        .checked_add(8)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| "Prebuilt index is truncated.".to_string())?;
    let value = f64::from_le_bytes(bytes[*cursor..end].try_into().unwrap());
    *cursor = end;
    Ok(value)
}

/// Extract stars from an RGBA image and solve it against the initialized catalog.
#[wasm_bindgen]
pub fn solve_rgba(
    pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<String, JsValue> {
    solve_rgba_inner(pixels, width, height).map_err(js_error)
}

fn solve_rgba_inner(pixels: &[u8], width: u32, height: u32) -> Result<String, String> {
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixel_count| pixel_count.checked_mul(4))
        .ok_or_else(|| "Image dimensions exceed supported limits.".to_string())?;
    if width == 0 || height == 0 || pixels.len() != expected_len {
        return Err("RGBA buffer length does not match image dimensions.".to_string());
    }

    let grayscale = pixels
        .chunks_exact(4)
        .map(|rgba| {
            (0.2126 * f32::from(rgba[0])
                + 0.7152 * f32::from(rgba[1])
                + 0.0722 * f32::from(rgba[2]))
                * (f32::from(rgba[3]) / 255.0)
        })
        .collect::<Vec<_>>();
    let image = Array2::from_shape_vec((height as usize, width as usize), grayscale)
        .map_err(|error| error.to_string())?;

    INDEX.with(|current| {
        let current = current.borrow();
        let index = current
            .as_ref()
            .ok_or_else(|| "Star catalog has not been initialized.".to_string())?;
        let extraction = ExtractionConfig::default();
        let sources = zodiacal::extraction::extract_sources(&image, &extraction);
        if sources.len() < 4 {
            return Err("Not enough stars detected to solve this image.".to_string());
        }

        let solver_config = SolverConfig {
            max_field_stars: 16,
            timeout: Some(Duration::from_secs(MAX_SOLVE_SECONDS)),
            verify: zodiacal::verify::VerifyConfig {
                match_radius_pix: 3.0,
                log_odds_accept: 30.0,
                min_matches: 12,
                ..zodiacal::verify::VerifyConfig::default()
            },
            ..SolverConfig::default()
        };
        let (solution, stats) = solve(
            &sources,
            &[index],
            (f64::from(width), f64::from(height)),
            &solver_config,
        );
        let solution = solution.ok_or_else(|| {
            if stats.timed_out {
                format!("Plate solving timed out after {MAX_SOLVE_SECONDS} seconds.")
            } else {
                "No astrometric solution found.".to_string()
            }
        })?;
        let (ra_rad, dec_rad) = solution.wcs.field_center();
        let cd = solution.wcs.cd;
        let pixel_scale_arcsec =
            ((cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]).abs().sqrt())
                * ARCSECONDS_PER_RADIAN;
        let rotation_deg = cd[1][0].atan2(cd[0][0]).to_degrees();
        let output = SolutionOutput {
            ra_deg: ra_rad.to_degrees(),
            dec_deg: dec_rad.to_degrees(),
            pixel_scale_arcsec,
            rotation_deg,
            width,
            height,
            wcs: solution.wcs,
        };

        serde_json::to_string(&output).map_err(|error| error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use zodiacal::extraction::DetectedSource;
    use zodiacal::geom::tan::TanWcs;
    use zodiacal::verify::VerifyConfig;

    fn synthetic_catalog() -> (Vec<(u64, f64, f64, f64)>, Vec<DetectedSource>, TanWcs) {
        let size = 512.0;
        let scale = (2.0 / 3600.0_f64).to_radians();
        let wcs = TanWcs {
            crval: [1.0, 0.5],
            crpix: [size / 2.0, size / 2.0],
            cd: [[scale, 0.0], [0.0, scale]],
            image_size: [size, size],
        };
        let mut state = 314_159_265_u64;
        let mut catalog = Vec::new();
        let mut sources = Vec::new();

        for id in 0..25 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let x = 30.0 + (state as f64 / u64::MAX as f64) * 452.0;
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let y = 30.0 + (state as f64 / u64::MAX as f64) * 452.0;
            let (ra, dec) = wcs.pixel_to_radec(x, y);
            catalog.push((id, ra, dec, id as f64));
            sources.push(DetectedSource {
                x,
                y,
                flux: 1000.0 - id as f64 * 10.0,
            });
        }

        (catalog, sources, wcs)
    }

    #[test]
    fn solves_a_synthetic_field_with_zodiacal() {
        let (catalog, sources, truth) = synthetic_catalog();
        let scale = (2.0 / 3600.0_f64).to_radians();
        let catalog = InMemoryCatalog(
            catalog
                .iter()
                .map(|&(id, ra, dec, magnitude)| {
                    StarData::with_position(
                        id,
                        Equatorial::new(ra, dec),
                        magnitude,
                        None,
                    )
                })
                .collect(),
        );
        let index = build_index_from_catalog(
            &catalog,
            &CatalogBuilderConfig {
                scale_lower: scale * 10.0,
                scale_upper: (2.0_f64 * 512.0_f64.powi(2)).sqrt() * scale,
                max_stars_per_cell: 64,
                max_quads: None,
                uniformize_depth: Some(6),
                quad_depth: None,
                passes: 16,
                max_reuse: 8,
            },
        );
        let config = SolverConfig {
            max_field_stars: 25,
            verify: VerifyConfig {
                match_radius_pix: 3.0,
                log_odds_accept: 10.0,
                min_matches: 3,
                ..VerifyConfig::default()
            },
            ..SolverConfig::default()
        };
        let (solution, _) = solve(&sources, &[&index], (512.0, 512.0), &config);
        let solution = solution.expect("Zodiacal should solve the synthetic star field");
        let (ra, dec) = solution.wcs.field_center();
        let (true_ra, true_dec) = truth.field_center();

        assert!((ra - true_ra).abs() * ARCSECONDS_PER_RADIAN < 30.0);
        assert!((dec - true_dec).abs() * ARCSECONDS_PER_RADIAN < 30.0);
    }

    #[test]
    fn extracts_and_solves_stars_from_rgba_pixels() {
        let (catalog, sources, truth) = synthetic_catalog();
        let stars = catalog
            .iter()
            .flat_map(|(id, ra, dec, magnitude)| {
                [*id as f32, *ra as f32, *dec as f32, *magnitude as f32]
            })
            .collect::<Vec<_>>();
        initialize_catalog_inner(&stars).expect("the synthetic catalog should be valid");

        let mut pixels = vec![0_u8; 512 * 512 * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        for source in &sources {
            let center_x = source.x.round() as i32;
            let center_y = source.y.round() as i32;
            for y in (center_y - 6).max(0)..=(center_y + 6).min(511) {
                for x in (center_x - 6).max(0)..=(center_x + 6).min(511) {
                    let distance_squared =
                        (x as f64 - source.x).powi(2) + (y as f64 - source.y).powi(2);
                    let intensity = (220.0 * (-distance_squared / 8.0).exp()) as u8;
                    let offset = ((y * 512 + x) * 4) as usize;
                    pixels[offset..offset + 3].fill(intensity);
                }
            }
        }

        let result = solve_rgba_inner(&pixels, 512, 512)
            .expect("the rendered synthetic star field should be solved");
        let result: serde_json::Value =
            serde_json::from_str(&result).expect("the solution should be valid JSON");
        let ra = result["ra_deg"].as_f64().expect("solution RA");
        let dec = result["dec_deg"].as_f64().expect("solution Dec");
        let (true_ra, true_dec) = truth.field_center();

        assert!((ra.to_radians() - true_ra).abs() * ARCSECONDS_PER_RADIAN < 30.0);
        assert!((dec.to_radians() - true_dec).abs() * ARCSECONDS_PER_RADIAN < 30.0);
    }

    #[test]
    fn rejects_an_empty_rgba_image() {
        let (catalog, _, _) = synthetic_catalog();
        let stars = catalog
            .iter()
            .flat_map(|(id, ra, dec, magnitude)| {
                [*id as f32, *ra as f32, *dec as f32, *magnitude as f32]
            })
            .collect::<Vec<_>>();
        initialize_catalog_inner(&stars).expect("the synthetic catalog should be valid");

        let mut pixels = vec![0_u8; 64 * 64 * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }

        assert_eq!(
            solve_rgba_inner(&pixels, 64, 64).unwrap_err(),
            "Not enough stars detected to solve this image."
        );
    }

    #[test]
    fn round_trips_a_prebuilt_index_from_bytes() {
        let (catalog, sources, truth) = synthetic_catalog();
        let catalog = InMemoryCatalog(
            catalog
                .iter()
                .map(|&(id, ra, dec, magnitude)| {
                    StarData::with_position(id, Equatorial::new(ra, dec), magnitude, None)
                })
                .collect(),
        );
        let scale = (2.0 / 3600.0_f64).to_radians();
        let index = build_index_from_catalog(
            &catalog,
            &CatalogBuilderConfig {
                scale_lower: scale * 10.0,
                scale_upper: (2.0_f64 * 512.0_f64.powi(2)).sqrt() * scale,
                max_stars_per_cell: 64,
                max_quads: None,
                uniformize_depth: Some(6),
                quad_depth: None,
                passes: 16,
                max_reuse: 8,
            },
        );
        let filename = format!(
            "astro-wasm-index-{}-{}.zdcl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(filename);
        index.save(&path).expect("the synthetic index should serialize");
        let bytes = std::fs::read(&path).expect("the serialized index should be readable");
        std::fs::remove_file(path).expect("the temporary index should be removed");

        let loaded = load_index_from_bytes(&bytes)
            .expect("the serialized index should load from an in-memory buffer");
        assert_eq!(loaded.stars.len(), index.stars.len());
        assert_eq!(loaded.quads.len(), index.quads.len());

        let config = SolverConfig {
            max_field_stars: 25,
            verify: VerifyConfig {
                match_radius_pix: 3.0,
                log_odds_accept: 10.0,
                min_matches: 3,
                ..VerifyConfig::default()
            },
            ..SolverConfig::default()
        };
        let (solution, _) = solve(&sources, &[&loaded], (512.0, 512.0), &config);
        let solution = solution.expect("the loaded index should solve its source field");
        let (ra, dec) = solution.wcs.field_center();
        let (true_ra, true_dec) = truth.field_center();
        assert!((ra - true_ra).abs() * ARCSECONDS_PER_RADIAN < 30.0);
        assert!((dec - true_dec).abs() * ARCSECONDS_PER_RADIAN < 30.0);
    }

    #[test]
    fn rejects_a_truncated_prebuilt_index() {
        assert!(load_index_from_bytes(b"ZDCL\x02\x00\x00\x00").is_err());
    }

    #[test]
    fn solves_a_synthetic_field_with_the_prebuilt_full_index() {
        let catalog_bytes = include_bytes!("../../catalogs/zodiacal-stars.bin");
        let mut sources = Vec::new();
        let width = 3599_u32;
        let height = 2010_u32;
        let center_ra = 322.4929_f64.to_radians();
        let center_dec = 12.1667_f64.to_radians();
        let scale = (3.0 / 3600.0_f64).to_radians();
        let truth = TanWcs {
            crval: [center_ra, center_dec],
            crpix: [f64::from(width) / 2.0, f64::from(height) / 2.0],
            cd: [[scale, 0.0], [0.0, scale]],
            image_size: [f64::from(width), f64::from(height)],
        };

        for record in catalog_bytes.chunks_exact(16) {
            let ra = f32::from_le_bytes(record[4..8].try_into().unwrap());
            let dec = f32::from_le_bytes(record[8..12].try_into().unwrap());
            let magnitude = f32::from_le_bytes(record[12..16].try_into().unwrap());

            let ra = f64::from(ra);
            let dec = f64::from(dec);
            let delta_ra = ra - center_ra;
            let cos_c = center_dec.sin() * dec.sin()
                + center_dec.cos() * dec.cos() * delta_ra.cos();
            if cos_c <= 0.0 {
                continue;
            }
            let xi = dec.cos() * delta_ra.sin() / cos_c;
            let eta = (center_dec.cos() * dec.sin()
                - center_dec.sin() * dec.cos() * delta_ra.cos())
                / cos_c;
            let x = truth.crpix[0] + xi / scale;
            let y = truth.crpix[1] + eta / scale;
            if x >= 8.0
                && x < f64::from(width) - 8.0
                && y >= 8.0
                && y < f64::from(height) - 8.0
                && magnitude < 14.0
            {
                sources.push((x, y, magnitude));
            }
        }

        assert!(
            sources.len() >= 12,
            "the selected catalog field must contain enough detectable stars"
        );
        let field_star_count = sources.len();
        let index = load_index_from_bytes(include_bytes!("../../catalogs/zodiacal-index.zdcl"))
            .expect("the bundled prebuilt full-sky index should be valid");
        INDEX.with(|current| *current.borrow_mut() = Some(index));

        let mut pixels = vec![0_u8; width as usize * height as usize * 4];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        let brightest_magnitude = sources
            .iter()
            .map(|(_, _, magnitude)| *magnitude)
            .fold(f32::INFINITY, f32::min);
        for (x, y, magnitude) in sources {
            let peak = (220.0 * 10.0_f64.powf(-0.4 * f64::from(magnitude - brightest_magnitude)))
                .clamp(24.0, 220.0) as u8;
            let center_x = x.round() as i32;
            let center_y = y.round() as i32;
            for pixel_y in center_y - 6..=center_y + 6 {
                for pixel_x in center_x - 6..=center_x + 6 {
                    let distance_squared =
                        (f64::from(pixel_x) - x).powi(2) + (f64::from(pixel_y) - y).powi(2);
                    let intensity = (f64::from(peak) * (-distance_squared / 8.0).exp()) as u8;
                    let offset = ((pixel_y * width as i32 + pixel_x) * 4) as usize;
                    pixels[offset..offset + 3].fill(intensity);
                }
            }
        }

        let grayscale = pixels
            .chunks_exact(4)
            .map(|rgba| {
                (0.2126 * f32::from(rgba[0])
                    + 0.7152 * f32::from(rgba[1])
                    + 0.0722 * f32::from(rgba[2]))
                    * (f32::from(rgba[3]) / 255.0)
            })
            .collect::<Vec<_>>();
        let image = Array2::from_shape_vec((height as usize, width as usize), grayscale)
            .expect("the synthetic image dimensions should be valid");
        let detected = zodiacal::extraction::extract_sources(&image, &ExtractionConfig::default());
        eprintln!(
            "Prebuilt full index test: {} catalog stars in the field, {} image sources extracted.",
            field_star_count,
            detected.len()
        );
        assert!(
            detected.len() >= 12,
            "the synthetic image must yield enough detected sources for verification"
        );

        let result = solve_rgba_inner(&pixels, width, height)
            .expect("the full-sky index should solve its own synthetic star field");
        let result: serde_json::Value =
            serde_json::from_str(&result).expect("the solution should be valid JSON");
        let ra = result["ra_deg"].as_f64().expect("solution RA").to_radians();
        let dec = result["dec_deg"].as_f64().expect("solution Dec").to_radians();
        assert!((ra - center_ra).abs() * center_dec.cos() * ARCSECONDS_PER_RADIAN < 30.0);
        assert!((dec - center_dec).abs() * ARCSECONDS_PER_RADIAN < 30.0);
    }
}
