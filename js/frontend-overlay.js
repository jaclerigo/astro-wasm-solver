/**
 * Plugin Name: Astro WASM Plate Solver
 * File: js/frontend-overlay.js
 * Description: Controlos interativos do leitor no frontend (Pan, Zoom, SVG Overlay e Tooltips)
 */

document.addEventListener('DOMContentLoaded', function() {
    // Seleciona todos os containers interativos presentes na página
    const containers = document.querySelectorAll('.astro-viewer-container');

    containers.forEach(container => {
        initAstroViewer(container);
    });
});

/**
 * Inicializa um leitor de astrofotografia individual
 * @param {HTMLElement} container - O elemento .astro-viewer-container
 */
function initAstroViewer(container) {
    const panzoomTarget = container.querySelector('.astro-panzoom-target');
    const img           = container.querySelector('.astro-base-img');
    const svg           = container.querySelector('.astro-overlay-svg');
    const tooltip       = container.querySelector('.astro-tooltip');

    if (!panzoomTarget || !img || !svg) return;

    // 1. Extrair os dados astronómicos (objetos NGC/Messier) do data-attribute
    let astroObjects = [];
    try {
        astroObjects = JSON.parse(container.dataset.astroObjects || '[]');
    } catch (e) {
        console.error('[Astro Solver] Erro ao processar os dados dos objetos astronómicos:', e);
    }

    // 2. Inicializar a biblioteca Panzoom no elemento interno
    const panzoom = Panzoom(panzoomTarget, {
        maxScale: 6,        // Escala máxima de ampliação (6x)
        minScale: 1,        // Escala mínima (100%)
        contain: 'outside', // Impede que a foto seja arrastada para fora do container
        cursor: 'grab'
    });

    // Permitir zoom interativo com a roda do rato (Mouse Wheel)
    container.addEventListener('wheel', panzoom.zoomWithWheel);

    // 3. Ajustar o viewBox do SVG de acordo com a resolução real da fotografia
    const updateSVGViewBox = () => {
        const w = img.naturalWidth || img.clientWidth;
        const h = img.naturalHeight || img.clientHeight;
        if (w > 0 && h > 0) {
            svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
            renderAstroOverlay(svg, tooltip, astroObjects);
        }
    };

    if (img.complete) {
        updateSVGViewBox();
    } else {
        img.addEventListener('load', updateSVGViewBox);
    }

    // 4. Manter o tamanho aparente das labels e marcadores constante durante o zoom
    panzoomTarget.addEventListener('panzoomchange', (event) => {
        const currentScale = event.detail.scale;
        const invScale = 1 / currentScale;

        // Ajustar o tamanho dos textos das labels
        const labels = svg.querySelectorAll('.astro-target-label');
        labels.forEach(text => {
            const baseFontSize = 12;
            const xBase = parseFloat(text.dataset.xBase || text.getAttribute('x'));
            
            text.style.fontSize = `${baseFontSize * invScale}px`;
            text.setAttribute('x', xBase + (12 * invScale));
        });

        // Ajustar o raio dos círculos marcadores
        const markers = svg.querySelectorAll('.astro-target-marker');
        markers.forEach(circle => {
            const baseRadius = parseFloat(circle.dataset.baseRadius || 8);
            circle.setAttribute('r', (baseRadius * invScale).toString());
        });
    });

    // 5. Configurar os botões da barra de controlo flutuante
    const btnZoomIn  = container.querySelector('.btn-zoom-in');
    const btnZoomOut = container.querySelector('.btn-zoom-out');
    const btnReset   = container.querySelector('.btn-reset');
    const btnToggle  = container.querySelector('.btn-toggle-labels');

    if (btnZoomIn) {
        btnZoomIn.addEventListener('click', (e) => {
            e.stopPropagation();
            panzoom.zoomIn();
        });
    }

    if (btnZoomOut) {
        btnZoomOut.addEventListener('click', (e) => {
            e.stopPropagation();
            panzoom.zoomOut();
        });
    }

    if (btnReset) {
        btnReset.addEventListener('click', (e) => {
            e.stopPropagation();
            panzoom.reset();
        });
    }

    if (btnToggle) {
        btnToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            container.classList.toggle('show-annotations');
        });
    }

    // Ocultar a tooltip se o cursor sair da imagem
    container.addEventListener('mouseleave', () => {
        if (tooltip) tooltip.classList.remove('active');
    });
}

/**
 * Desenha os marcadores e rótulos no SVG com base no array de objetos astronómicos
 * @param {