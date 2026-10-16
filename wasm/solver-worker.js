/**
 * Plugin Name: Astro WASM Plate Solver
 * File: wasm/solver-worker.js
 * Description: Web Worker para processamento assíncrono de Plate Solving via WASM.
 */

// Importa a biblioteca de integração JS gerada pelo Emscripten
importScripts('solver-engine.js');

let wasmInstance = null;

/**
 * Carrega e inicializa os catálogos FITS em memória virtual do Emscripten (MEMFS)
 */
async function loadCatalogsIntoMEMFS(catalogUrls) {
    if (!wasmInstance) {
        // Inicializa o módulo WASM (Module é uma Promise global do solver-engine.js)
        wasmInstance = await Module();
    }

    // Cria a diretoria virtual no sistema de ficheiros em memória RAM
    try {
        wasmInstance.FS.mkdir('/catalogs');
    } catch (e) {
        // Ignora se a pasta já existir na sessão
    }

    // Descarrega cada ficheiro de catálogo e escreve no MEMFS
    for (const url of catalogUrls) {
        const fileName = url.split('/').pop();
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Falha ao descarregar o catálogo: ${fileName}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);

        // Guarda o ficheiro no sistema de ficheiros virtual do WASM
        wasmInstance.FS.writeFile(`/catalogs/${fileName}`, data);
    }
}

/**
 * Escuta as mensagens enviadas do painel de administração (admin-solver.js)
 */
self.onmessage = async function(e) {
    const { action, imageData, width, height, catalogUrls } = e.data;

    if (action === 'SOLVE_IMAGE') {
        try {
            self.postMessage({ status: 'PROGRESS', message: 'A carregar catálogos em memória RAM...' });
            await loadCatalogsIntoMEMFS(catalogUrls);

            self.postMessage({ status: 'PROGRESS', message: 'A detetar estrelas e a calcular o WCS...' });

            const uint8Pixels = new Uint8Array(imageData);
            const numBytes = uint8Pixels.length;

            // Aloca memória diretamente no Heap do WebAssembly
            const dataPtr = wasmInstance._malloc(numBytes);
            wasmInstance.HEAPU8.set(uint8Pixels, dataPtr);

            // Chama a função nativa em C/C++ exportada no binário .wasm
            // Int solve_field_wasm(uint8_t* pixels, int width, int height)
            const success = wasmInstance._solve_field_wasm(dataPtr, width, height);

            if (success === 1) {
                // Lê a estrutura de resultados do ponteiro WCS
                const ra_str   = wasmInstance.UTF8ToString(wasmInstance._get_solved_ra());
                const dec_str  = wasmInstance.UTF8ToString(wasmInstance._get_solved_dec());
                const scale    = wasmInstance._get_solved_scale();
                const rotation = wasmInstance._get_solved_rotation();
                const objects  = wasmInstance.UTF8ToString(wasmInstance._get_solved_objects_json());

                self.postMessage({
                    status: 'SUCCESS',
                    solution: {
                        ra_formatted: ra_str,
                        dec_formatted: dec_str,
                        pixscale: scale,
                        orientation: rotation,
                        matched_catalog_objects: JSON.parse(objects || '[]')
                    }
                });
            } else {
                self.postMessage({ status: 'ERROR', message: 'Não foi possível encontrar uma correspondência para os padrões de estrelas.' });
            }

            // Liberta a memória alocada no C
            wasmInstance._free(dataPtr);

        } catch (err) {
            self.postMessage({ status: 'ERROR', message: err.message });
        }
    }
};