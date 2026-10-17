/**
 * Plugin Name: Astro WASM Plate Solver
 * File: js/frontend-overlay.js
 * Description: Controlos interativos do leitor no frontend (Pan, Zoom, SVG Overlay e Tooltips)
 */

document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('.astro-viewer-container').forEach(initAstroViewer);
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
    if (!Array.isArray(astroObjects)) {
        console.error('[Astro Solver] A lista de objetos astronómicos tem de ser um array.');
        astroObjects = [];
    }

    const panzoom = typeof Panzoom === 'function'
        ? Panzoom(panzoomTarget, {
            maxScale: 6,
            minScale: 1,
            contain: 'outside',
            cursor: 'grab'
        })
        : null;

    if (panzoom) {
        container.addEventListener('wheel', panzoom.zoomWithWheel);
    } else {
        console.error('[Astro Solver] A biblioteca Panzoom não está disponível.');
    }

    const updateSVGViewBox = () => {
        const w = img.naturalWidth || img.clientWidth;
        const h = img.naturalHeight || img.clientHeight;
        if (w > 0 && h > 0) {
            svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
            renderAstroOverlay(svg, tooltip, container, astroObjects);
        }
    };

    if (img.complete) {
        updateSVGViewBox();
    } else {
        img.addEventListener('load', updateSVGViewBox);
    }

    panzoomTarget.addEventListener('panzoomchange', event => {
        if (!event.detail || !Number.isFinite(event.detail.scale) || event.detail.scale <= 0) {
            return;
        }

        const currentScale = event.detail.scale;
        const invScale = 1 / currentScale;

        const labels = svg.querySelectorAll('.astro-target-label');
        labels.forEach(text => {
            text.style.fontSize = `${12 * invScale}px`;
            text.setAttribute('x', String(
                parseFloat(text.dataset.xBase) + (12 * invScale)
            ));
        });

        const markers = svg.querySelectorAll('.astro-target-marker');
        markers.forEach(circle => {
            circle.setAttribute('r', String(parseFloat(circle.dataset.baseRadius) * invScale));
        });
    });

    const btnZoomIn  = container.querySelector('.btn-zoom-in');
    const btnZoomOut = container.querySelector('.btn-zoom-out');
    const btnReset   = container.querySelector('.btn-reset');
    const btnToggle  = container.querySelector('.btn-toggle-labels');

    if (btnZoomIn && panzoom) {
        btnZoomIn.addEventListener('click', (e) => {
            e.stopPropagation();
            panzoom.zoomIn();
        });
    }

    if (btnZoomOut && panzoom) {
        btnZoomOut.addEventListener('click', (e) => {
            e.stopPropagation();
            panzoom.zoomOut();
        });
    }

    if (btnReset && panzoom) {
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

    container.addEventListener('mouseleave', () => {
        if (tooltip) tooltip.classList.remove('active');
    });
}

/**
 * Desenha os objetos cujas coordenadas já foram projetadas para píxeis da imagem.
 * @param {SVGElement} svg
 * @param {?HTMLElement} tooltip
 * @param {HTMLElement} container
 * @param {Array<Object>} astroObjects
 */
function renderAstroOverlay(svg, tooltip, container, astroObjects) {
    while (svg.firstChild) {
        svg.removeChild(svg.firstChild);
    }

    astroObjects.forEach(object => {
        const x = Number(object.x);
        const y = Number(object.y);
        const name = typeof object.name === 'string' ? object.name.trim() : '';
        const radius = Number(object.radius);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !name) {
            return;
        }

        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        marker.setAttribute('cx', String(x));
        marker.setAttribute('cy', String(y));
        marker.setAttribute('r', String(Number.isFinite(radius) && radius > 0 ? radius : 8));
        marker.setAttribute('class', 'astro-target-marker');
        marker.setAttribute('tabindex', '0');
        marker.setAttribute('role', 'img');
        marker.dataset.baseRadius = String(Number.isFinite(radius) && radius > 0 ? radius : 8);
        marker.setAttribute('aria-label', name);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', String(x + (Number.isFinite(radius) && radius > 0 ? radius : 8) + 4));
        label.setAttribute('y', String(y));
        label.setAttribute('class', 'astro-target-label');
        label.dataset.xBase = label.getAttribute('x');
        label.textContent = name;

        if (tooltip) {
            const showTooltip = event => {
                while (tooltip.firstChild) {
                    tooltip.removeChild(tooltip.firstChild);
                }

                const title = document.createElement('strong');
                title.textContent = name;
                tooltip.appendChild(title);

                if (typeof object.type === 'string' && object.type.trim()) {
                    const type = document.createElement('span');
                    type.textContent = ` — ${object.type.trim()}`;
                    tooltip.appendChild(type);
                }

                if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
                    const bounds = container.getBoundingClientRect();
                    tooltip.style.left = `${event.clientX - bounds.left}px`;
                    tooltip.style.top = `${event.clientY - bounds.top}px`;
                }

                tooltip.classList.add('active');
            };

            marker.addEventListener('pointerenter', showTooltip);
            marker.addEventListener('pointermove', showTooltip);
            marker.addEventListener('focus', showTooltip);
            marker.addEventListener('pointerleave', () => tooltip.classList.remove('active'));
            marker.addEventListener('blur', () => tooltip.classList.remove('active'));
        }

        svg.append(marker, label);
    });
}
