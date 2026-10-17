const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
    const fetchCounts = new Map();
    const context = vm.createContext({
        ArrayBuffer,
        Float32Array,
        Response,
        TextDecoder,
        TextEncoder,
        URL,
        Uint8Array,
        WebAssembly,
        clearTimeout,
        console,
        fetch,
        performance,
        setTimeout
    });
    const messages = [];
    context.self = {
        location: { href: 'https://example.test/plugin/wasm/solver-worker.js' },
        performance,
        postMessage: message => messages.push({ message, at: performance.now() })
    };
    context.importScripts = url => vm.runInContext(
        fs.readFileSync('wasm/zodiacal/solver.js', 'utf8'),
        context,
        { filename: String(url) }
    );
    vm.runInContext(fs.readFileSync('wasm/solver-worker.js', 'utf8'), context, {
        filename: 'wasm/solver-worker.js'
    });

    const starIndex = fs.readFileSync('catalogs/zodiacal-index.zdcl');
    const objectCatalog = fs.readFileSync('catalogs/openngc.json');
    const wasmBinary = fs.readFileSync('wasm/zodiacal/solver_bg.wasm');
    context.fetch = async url => {
        const path = String(url);
        const resource = path.endsWith('zodiacal-index.zdcl')
            ? 'index'
            : path.endsWith('openngc.json')
                ? 'objects'
                : path.endsWith('solver_bg.wasm')
                    ? 'wasm'
                    : path;
        fetchCounts.set(resource, (fetchCounts.get(resource) || 0) + 1);
        if (path.endsWith('zodiacal-index.zdcl')) {
            return new Response(starIndex);
        }
        if (path.endsWith('openngc.json')) {
            return new Response(objectCatalog);
        }
        if (path.endsWith('solver_bg.wasm')) {
            return new Response(wasmBinary, {
                headers: { 'Content-Type': 'application/wasm' }
            });
        }
        throw new Error(`Unexpected request: ${path}`);
    };

    testTanProjection(context);
    const memoryBefore = process.memoryUsage();
    await testBlankImageHandling(context, messages);
    for (const resource of ['wasm', 'index', 'objects']) {
        assert.equal(fetchCounts.get(resource), 1, `${resource} should only load once`);
    }
    reportRuntimeMeasurements(messages, memoryBefore, process.memoryUsage());
}

function testTanProjection(context) {
    const wcs = {
        crval: [1, 0.5],
        crpix: [50, 40],
        cd: [[0.001, 0.0002], [-0.0001, 0.0011]]
    };
    const [raDeg, decDeg] = radecAtPixel(wcs, 60, 45);
    const objects = [
        { name: 'center', ra_deg: 180 / Math.PI, dec_deg: 0.5 * 180 / Math.PI },
        { name: 'offset', ra_deg: raDeg, dec_deg: decDeg },
        { name: 'outside', ra_deg: 100, dec_deg: 70 }
    ];
    const projected = vm.runInContext(
        `projectObjects(${JSON.stringify(wcs)}, ${JSON.stringify(objects)}, 100, 80)`,
        context
    );

    assert.equal(projected.length, 2);
    assert.ok(Math.abs(projected[0].x - 50) < 1e-8);
    assert.ok(Math.abs(projected[0].y - 40) < 1e-8);
    assert.ok(Math.abs(projected[1].x - 60) < 1e-7);
    assert.ok(Math.abs(projected[1].y - 45) < 1e-7);
}

function radecAtPixel(wcs, pixelX, pixelY) {
    const dx = pixelX - wcs.crpix[0];
    const dy = pixelY - wcs.crpix[1];
    const xi = wcs.cd[0][0] * dx + wcs.cd[0][1] * dy;
    const eta = wcs.cd[1][0] * dx + wcs.cd[1][1] * dy;
    const [ra0, dec0] = wcs.crval;
    const cosDec = Math.cos(dec0);
    const sinDec = Math.sin(dec0);
    const reference = [cosDec * Math.cos(ra0), cosDec * Math.sin(ra0), sinDec];
    const east = [-Math.sin(ra0), Math.cos(ra0), 0];
    const north = [-sinDec * Math.cos(ra0), -sinDec * Math.sin(ra0), cosDec];
    const xyz = reference.map((value, axis) => value + xi * east[axis] + eta * north[axis]);
    const norm = Math.hypot(...xyz);

    return [
        Math.atan2(xyz[1] / norm, xyz[0] / norm) * 180 / Math.PI,
        Math.asin(xyz[2] / norm) * 180 / Math.PI
    ];
}

async function testBlankImageHandling(context, messages) {
    const pixels = new Uint8Array(64 * 64 * 4);
    for (let offset = 3; offset < pixels.length; offset += 4) {
        pixels[offset] = 255;
    }
    const urls = {
        indexUrl: 'https://example.test/catalogs/zodiacal-index.zdcl',
        objectCatalogUrl: 'https://example.test/catalogs/openngc.json'
    };

    for (const requestId of [11, 12]) {
        context.self.onmessage({
            data: {
                action: 'SOLVE_IMAGE',
                requestId,
                imageData: pixels.buffer.slice(0),
                width: 64,
                height: 64,
                ...urls
            }
        });
    }

    await new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            const terminalMessages = messages.filter(
                ({ message }) => message.status === 'ERROR' || message.status === 'SUCCESS'
            );
            if (terminalMessages.length === 2) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - startedAt > 20_000) {
                clearInterval(timer);
                reject(new Error('Worker responses timed out.'));
            }
        }, 50);
    });

    const terminalMessages = messages.filter(
        ({ message }) => message.status === 'ERROR' || message.status === 'SUCCESS'
    );
    assert.deepEqual(
        terminalMessages.map(({ message }) => message.requestId).sort(),
        [11, 12]
    );
    for (const { message } of terminalMessages) {
        assert.equal(message.status, 'ERROR');
        assert.match(message.message, /Not enough stars detected/);
    }
}

function reportRuntimeMeasurements(messages, memoryBefore, memoryAfter) {
    const firstRequest = messages
        .filter(({ message }) => message.requestId === 11)
        .sort((left, right) => left.at - right.at);
    const progress = firstRequest.filter(({ message }) => message.status === 'PROGRESS');
    const timeBetween = (start, end) => {
        const startMessage = progress.find(({ message }) => message.message === start);
        const endMessage = progress.find(({ message }) => message.message === end);
        return startMessage && endMessage ? endMessage.at - startMessage.at : null;
    };
    const terminal = firstRequest.find(({ message }) =>
        message.status === 'ERROR' || message.status === 'SUCCESS'
    );
    const rssDelta = (memoryAfter.rss - memoryBefore.rss) / (1024 * 1024);
    const externalDelta = (memoryAfter.external - memoryBefore.external) / (1024 * 1024);

    console.log(`Serialized index size: ${fs.statSync('catalogs/zodiacal-index.zdcl').size} bytes.`);
    console.log(`Index parse/initialization: ${timeBetween(
        'A carregar o índice estelar...',
        'A carregar o catálogo Messier/NGC...'
    )?.toFixed(1) ?? 'unavailable'} ms.`);
    console.log(`First request total: ${
        terminal ? (terminal.at - firstRequest[0].at).toFixed(1) : 'unavailable'
    } ms.`);
    console.log(`Node process memory delta: RSS ${rssDelta.toFixed(1)} MiB, external ${
        externalDelta.toFixed(1)
    } MiB (indicative only; not browser memory).`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
