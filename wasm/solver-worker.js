/**
 * Plugin Name: Astro WASM Plate Solver
 * File: wasm/solver-worker.js
 * Description: Web Worker para processamento assíncrono de plate solving via Zodiacal/WASM.
 */

importScripts(new URL('zodiacal/solver.js', self.location.href).href);

let wasmReady;
let indexReady;
let initializedIndexUrl;
let objectCatalogReady;
let objectCatalog;
let initializedObjectCatalogUrl;
let workerQueue = Promise.resolve();

async function initializeWasm() {
    if (!wasmReady) {
        const wasmUrl = new URL('zodiacal/solver_bg.wasm', self.location.href);
        wasmReady = wasm_bindgen({ module_or_path: wasmUrl });
    }

    try {
        await wasmReady;
    } catch (error) {
        wasmReady = null;
        throw error;
    }
}

async function initializeIndex(indexUrl, sendProgress) {
    if (initializedIndexUrl === indexUrl) {
        return;
    }

    if (indexReady) {
        throw new Error('O índice estelar já foi carregado com outro URL.');
    }

    indexReady = (async () => {
        sendProgress('A descarregar o índice estelar...');
        const response = await fetch(indexUrl);
        if (!response.ok) {
            throw new Error(`Falha ao descarregar o índice estelar (${response.status}).`);
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength < 48) {
            throw new Error('O ficheiro do índice estelar está incompleto.');
        }

        sendProgress('A carregar o índice estelar...');
        wasm_bindgen.initialize_index(new Uint8Array(buffer));
        initializedIndexUrl = indexUrl;
    })();

    try {
        await indexReady;
    } catch (error) {
        indexReady = null;
        throw error;
    }
}

async function loadObjectCatalog(objectCatalogUrl, sendProgress) {
    if (initializedObjectCatalogUrl === objectCatalogUrl) {
        return objectCatalog;
    }
    if (objectCatalogReady && initializedObjectCatalogUrl !== objectCatalogUrl) {
        throw new Error('O catálogo de objetos já foi carregado com outro URL.');
    }

    if (!objectCatalogReady) {
        objectCatalogReady = (async () => {
            sendProgress('A carregar o catálogo Messier/NGC...');
            const response = await fetch(objectCatalogUrl);
            if (!response.ok) {
                throw new Error(`Falha ao descarregar o catálogo Messier/NGC (${response.status}).`);
            }

            const records = await response.json();
            if (!Array.isArray(records)) {
                throw new Error('O catálogo Messier/NGC tem um formato inválido.');
            }

            objectCatalog = records;
            initializedObjectCatalogUrl = objectCatalogUrl;
        })();
    }

    try {
        await objectCatalogReady;
        return objectCatalog;
    } catch (error) {
        objectCatalogReady = null;
        objectCatalog = null;
        initializedObjectCatalogUrl = null;
        throw error;
    }
}

function projectObjects(wcs, records, width, height) {
    const [ra0, dec0] = wcs.crval;
    const [crpixX, crpixY] = wcs.crpix;
    const [[cd11, cd12], [cd21, cd22]] = wcs.cd;
    const determinant = cd11 * cd22 - cd12 * cd21;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-20) {
        throw new Error('O WCS devolvido pelo solver é inválido.');
    }

    const sinDec0 = Math.sin(dec0);
    const cosDec0 = Math.cos(dec0);

    return records.flatMap(record => {
        const ra = Number(record.ra_deg) * Math.PI / 180;
        const dec = Number(record.dec_deg) * Math.PI / 180;
        if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
            return [];
        }

        const deltaRa = Math.atan2(Math.sin(ra - ra0), Math.cos(ra - ra0));
        const sinDec = Math.sin(dec);
        const cosDec = Math.cos(dec);
        const cosDistance = sinDec0 * sinDec + cosDec0 * cosDec * Math.cos(deltaRa);
        if (cosDistance <= 0) {
            return [];
        }

        const xi = cosDec * Math.sin(deltaRa) / cosDistance;
        const eta = (cosDec0 * sinDec - sinDec0 * cosDec * Math.cos(deltaRa)) / cosDistance;
        const x = crpixX + (cd22 * xi - cd12 * eta) / determinant;
        const y = crpixY + (-cd21 * xi + cd11 * eta) / determinant;
        if (x < 0 || x >= width || y < 0 || y >= height) {
            return [];
        }

        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!name) {
            return [];
        }

        return [{
            name,
            type: typeof record.type === 'string' ? record.type : '',
            x,
            y,
            radius: 8
        }];
    });
}

async function solveImage(data) {
    const {
        requestId,
        imageData,
        width,
        height,
        indexUrl,
        objectCatalogUrl
    } = data;
    const sendProgress = message => self.postMessage({ requestId, status: 'PROGRESS', message });

    try {
        if (!(imageData instanceof ArrayBuffer) || !Number.isInteger(width) || !Number.isInteger(height)) {
            throw new Error('Os dados da imagem ou as dimensões são inválidos.');
        }
        if (typeof indexUrl !== 'string' || indexUrl.length === 0) {
            throw new Error('O URL do índice estelar não está configurado.');
        }
        if (typeof objectCatalogUrl !== 'string' || objectCatalogUrl.length === 0) {
            throw new Error('O URL do catálogo Messier/NGC não está configurado.');
        }

        sendProgress('A carregar o solver WebAssembly...');
        await initializeWasm();
        await initializeIndex(indexUrl, sendProgress);
        const objects = await loadObjectCatalog(objectCatalogUrl, sendProgress);

        sendProgress('A detetar estrelas e a calcular o WCS...');
        const result = JSON.parse(
            wasm_bindgen.solve_rgba(new Uint8Array(imageData), width, height)
        );
        const matchedObjects = projectObjects(result.wcs, objects, width, height);
        self.postMessage({
            requestId,
            status: 'SUCCESS',
            solution: {
                ra_formatted: result.ra_deg.toFixed(6),
                dec_formatted: result.dec_deg.toFixed(6),
                pixscale: result.pixel_scale_arcsec,
                orientation: result.rotation_deg,
                wcs: result.wcs,
                matched_catalog_objects: matchedObjects
            }
        });
    } catch (error) {
        self.postMessage({
            requestId,
            status: 'ERROR',
            message: error instanceof Error ? error.message : String(error)
        });
    }
}

self.onmessage = function(event) {
    const data = event.data || {};
    if (data.action !== 'SOLVE_IMAGE') {
        return;
    }

    workerQueue = workerQueue.then(() => solveImage(data)).catch(error => {
        self.postMessage({
            requestId: data.requestId,
            status: 'ERROR',
            message: error instanceof Error ? error.message : String(error)
        });
    });
};
