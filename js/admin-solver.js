/**
 * Plugin Name: Astro WASM Plate Solver
 * File: js/admin-solver.js
 * Description: Gestão do botão de Plate Solving na Biblioteca Multimédia e ponte para o Web Worker WASM.
 */

(function($) {
    'use strict';

    // Referência global para o Web Worker do Solver
    let solverWorker = null;
    let nextWorkerRequestId = 0;
    const pendingWorkerRequests = new Map();

    function failPendingWorkerRequests(error) {
        pendingWorkerRequests.forEach(request => request.reject(error));
        pendingWorkerRequests.clear();
    }

    function positionPlateSolverButton() {
        document.querySelectorAll('.aws-run-wasm-solver-btn').forEach(button => {
            const mediaModal = button.closest('.media-modal');
            const editImageLink = mediaModal &&
                mediaModal.querySelector('.attachment-actions .edit-attachment');
            if (!editImageLink || button.previousElementSibling === editImageLink) {
                return;
            }

            editImageLink.insertAdjacentElement('afterend', button);
            button.classList.add('aws-plate-solving-action');
        });
    }

    function observeAttachmentDetails() {
        positionPlateSolverButton();

        if (!document.body || typeof MutationObserver !== 'function') {
            return;
        }

        const observer = new MutationObserver(positionPlateSolverButton);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeAttachmentDetails, { once: true });
    } else {
        observeAttachmentDetails();
    }

    /**
     * Inicializa o Web Worker em segundo plano
     */
    function initWorker() {
        if (!solverWorker && typeof AWS_Settings !== 'undefined') {
            const workerUrl = AWS_Settings.plugin_url + 'wasm/solver-worker.js';
            solverWorker = new Worker(workerUrl);
            solverWorker.onmessage = function(event) {
                const { requestId, status, message, solution } = event.data;
                const request = pendingWorkerRequests.get(requestId);
                if (!request) return;

                if (status === 'PROGRESS') {
                    request.$button.html('⚡ ' + message);
                } else if (status === 'SUCCESS') {
                    pendingWorkerRequests.delete(requestId);
                    request.resolve(solution);
                } else if (status === 'ERROR') {
                    pendingWorkerRequests.delete(requestId);
                    request.reject(new Error(message));
                }
            };

            solverWorker.onerror = function(error) {
                const workerError = new Error('Erro interno no Worker WebAssembly: ' + error.message);
                failPendingWorkerRequests(workerError);
                solverWorker.terminate();
                solverWorker = null;
            };

            solverWorker.onmessageerror = function() {
                failPendingWorkerRequests(new Error('Não foi possível interpretar uma resposta do Web Worker.'));
            };
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
                            objects: JSON.stringify(solution.matched_catalog_objects),
                            wcs: JSON.stringify(solution.wcs)
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

            const requestId = ++nextWorkerRequestId;
            pendingWorkerRequests.set(requestId, { resolve, reject, $button });

            try {
                worker.postMessage({
                    action: 'SOLVE_IMAGE',
                    requestId,
                    imageData: imageData.data.buffer,
                    width: width,
                    height: height,
                    indexUrl: AWS_Settings.index_url,
                    objectCatalogUrl: AWS_Settings.object_catalog_url
                }, [imageData.data.buffer]);
            } catch (error) {
                pendingWorkerRequests.delete(requestId);
                reject(error);
            }
        });
    }

})(jQuery);