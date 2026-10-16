/**
 * Plugin Name: Astro WASM Plate Solver
 * File: js/admin-solver.js
 * Description: Gestão do botão de Plate Solving na Biblioteca Multimédia e ponte para o Web Worker WASM.
 */

(function($) {
    'use strict';

    // Referência global para o Web Worker do Solver
    let solverWorker = null;

    /**
     * Inicializa o Web Worker em segundo plano
     */
    function initWorker() {
        if (!solverWorker && typeof AWS_Settings !== 'undefined') {
            const workerUrl = AWS_Settings.plugin_url + 'wasm/solver-worker.js';
            solverWorker = new Worker(workerUrl);
        }
        return solverWorker;
    }

    /**
     * Captura o clique no botão de Plate Solving no modal de detalhes do anexo (upload.php / media frame)
     */
    $(document).on('click', '.aws-run-wasm-solver-btn', function(e) {
        e.preventDefault();

        const $button = $(this);
        const attachmentId = $button.data('attachment-id');
        const imageUrl = $button.data('image-url');

        if (!attachmentId || !imageUrl) {
            alert('Erro: ID do anexo ou URL da imagem indisponível.');
            return;
        }

        // Bloquear o botão e alterar o estado visual
        $button.prop('disabled', true)
               .css({'opacity': '0.7', 'cursor': 'wait'})
               .html('⚡ A inicializar motor WASM...');

        // 1. Carregar a imagem em memória (HTML Image Object)
        const img = new Image();
        img.crossOrigin = 'Anonymous'; // Evita problemas de CORS se aplicável
        img.src = imageUrl;

        img.onload = function() {
            // 2. Extrair os píxeis da imagem via Canvas HTML5
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            // 3. Executar o Solving no Web Worker
            runWasmPlateSolver(imageData, canvas.width, canvas.height, $button)
                .then(solution => {
                    $button.html('💾 A guardar metadados no WordPress...');

                    // 4. Enviar os resultados para o PHP guardar no wp_postmeta via AJAX
                    return $.ajax({
                        url: AWS_Settings.ajax_url,
                        type: 'POST',
                        data: {
                            action: 'aws_save_solving',
                            nonce: AWS_Settings.nonce,
                            attachment_id: attachmentId,
                            ra: solution.ra_formatted,
                            dec: solution.dec_formatted,
                            scale: solution.pixscale,
                            rotation: solution.orientation,
                            objects: JSON.stringify(solution.matched_catalog_objects)
                        }
                    });
                })
                .then(response => {
                    if (response.success) {
                        $button.css({'opacity': '1', 'cursor': 'pointer'})
                               .html('✓ Plate Solving Concluído!');
                        
                        // Recarrega ligeiramente a secção para atualizar o estado de "✓ Resolvido"
                        setTimeout(() => {
                            if (typeof wp !== 'undefined' && wp.media && wp.media.frame) {
                                // Se estiver dentro do modal da Media Library, atualiza o modelo
                                const attachment = wp.media.attachment(attachmentId);
                                if (attachment) attachment.fetch();
                            } else {
                                location.reload();
                            }
                        }, 1200);

                    } else {
                        throw new Error(response.data ? response.data.message : 'Erro ao guardar no servidor.');
                    }
                })
                .catch(error => {
                    console.error('[Astro WASM Solver Error]:', error);
                    $button.prop('disabled', false)
                           .css({'opacity': '1', 'cursor': 'pointer'})
                           .html('❌ Falha no Solving. Tentar novamente');
                    
                    alert('Erro durante o Plate Solving: ' + error.message);
                });
        };

        img.onerror = function() {
            $button.prop('disabled', false)
                   .css({'opacity': '1', 'cursor': 'pointer'})
                   .html('❌ Erro ao carregar ficheiro de imagem.');
        };
    });

    /**
     * Envia os píxeis da imagem e a lista de catálogos para o Web Worker
     */
    function runWasmPlateSolver(imageData, width, height, $button) {
        return new Promise((resolve, reject) => {
            const worker = initWorker();

            if (!worker) {
                reject(new Error('Não foi possível inicializar o Web Worker.'));
                return;
            }

            // Escuta as mensagens enviadas pelo worker-solver.js
            worker.onmessage = function(e) {
                const { status, message, solution } = e.data;

                if (status === 'PROGRESS') {
                    // Atualiza o texto do botão com o progresso do motor
                    $button.html('⚡ ' + message);
                } else if (status === 'SUCCESS') {
                    resolve(solution);
                } else if (status === 'ERROR') {
                    reject(new Error(message));
                }
            };

            worker.onerror = function(err) {
                reject(new Error('Erro interno no Worker WebAssembly: ' + err.message));
            };

            // Transfere o buffer de píxeis para o Worker (zero-copy overhead)
            worker.postMessage({
                action: 'SOLVE_IMAGE',
                imageData: imageData.data.buffer,
                width: width,
                height: height,
                catalogUrls: AWS_Settings.catalogs || []
            }, [imageData.data.buffer]);
        });
    }

})(jQuery);