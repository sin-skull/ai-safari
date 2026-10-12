// Isolated software test, never connects to the user's browser profile.
// npm install --no-save playwright && npx playwright install webkit
// node tests/mobile-webkit.cjs [screenshot path]
// BROWSER_ENGINE=chromium also verifies context.setOffline(true).
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webkit, chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.BROWSER_ENGINE || 'webkit';

(async () => {
  const root = path.resolve(__dirname, '..');
  let serving = true;
  // A private origin that can be disconnected without changing the user's network.
  const server = http.createServer(async (req, res) => {
    if (!serving) return req.socket.destroy();
    const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (requested.endsWith('/') ? requested + 'index.html' : requested));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const content = await fs.readFile(file);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }); res.end(content);
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = new URL(`http://127.0.0.1:${server.address().port}/`);
  const url = value => new URL(value, base).href;
  let browser;
  const errors = [];
  try {
    browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
    const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    // Four logical CPUs, as reported by the user's device. Inference itself uses one thread.
    await context.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 }));
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') console.log('Browser error:', msg.text().slice(0, 250)); });
    await page.goto(base.href);
    await page.waitForFunction(() => !document.querySelector('#prepare').disabled);
    const env = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      touch: navigator.maxTouchPoints, cores: navigator.hardwareConcurrency,
      isolated: crossOriginIsolated, opfs: !!navigator.storage?.getDirectory,
      jspi: !!WebAssembly.Suspending, ua: navigator.userAgent,
    }));
    console.log('Environment:', engine, JSON.stringify(env));
    assert.equal(env.width, 390);
    assert.ok(env.scrollWidth <= env.width, 'No horizontal overflow');
    await page.evaluate(() => { window.testTouches = 0; document.addEventListener('touchstart', () => window.testTouches++); });
    await page.touchscreen.tap(10, 10);
    assert.ok(await page.evaluate(() => window.testTouches > 0), 'Emulated touch event');
    assert.equal(env.isolated, false, 'GitHub Pages single-thread conditions');
    assert.equal(await page.locator('#profile').inputValue(), 'mobile');
    assert.equal(await page.locator('#input').isDisabled(), true, 'No automatic model allocation');
    await page.waitForFunction(() => document.querySelector('#offline').textContent.includes('保存済み'));
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.deepEqual(errors, [], 'No startup errors');
    if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });

    // WebKit's offline emulation has an upstream SW bug (#42775). Disconnect
    // the origin instead; Chromium additionally uses browser-wide offline mode.
    serving = false;
    if (engine === 'chromium') await context.setOffline(true);
    assert.equal(await page.evaluate(async () => {
      try { await fetch('uncached-network-probe-' + Date.now()); return false; }
      catch (_) { return true; }
    }), true, 'Uncached network requests really fail');
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#prepare').disabled);
    if (engine === 'chromium') assert.equal(await page.evaluate(() => navigator.onLine), false);
    assert.match(await page.locator('footer').innerText(), /ai Safari/);
    // Windows WebKit additionally reports the intentionally failed probe as
    // pageerror events, although fetch's rejection above was handled.
    const unexpected = errors.filter(message => message !== 'TypeError: Load failed' && !message.includes('/uncached-network-probe-'));
    assert.deepEqual(unexpected, []);
    errors.length = 0;
    console.log('PASS: mobile layout, manual startup, cached offline reload');

    // Actual WASM CPU inference with the bundled 0.5 MB plumbing model.
    // It checks runtime compatibility, not Japanese quality or 400 MB model memory use.
    // Direct Blob loading intentionally does not pretend OPFS exists on Windows WebKit.
    const result = await page.evaluate(async () => {
      const abs = path => new URL(path, location.href).href;
      const { Wllama, LoggerWithoutDebug, CacheManager } = await import(abs('lab/vendor/wllama-3.6.1/index.js'));
      // Persistence is not part of this tiny-model runtime test. Fail if used.
      const noStorage = { isSupported: () => true, list: async () => [], read: async () => null, getSize: async () => -1, write: async () => { throw new Error('Unexpected persistence in direct-Blob test'); } };
      const w = new Wllama({ default: abs('lab/vendor/wllama-3.6.1/wasm/wllama.wasm') }, { logger: LoggerWithoutDebug, cacheManager: new CacheManager([noStorage]) });
      const { configureRuntime } = await import(abs('js/runtime-compat.mjs'));
      configureRuntime(w, { worker: abs('lab/vendor/wllama-compat-3.6.1/wasm/wllama.js'), wasm: abs('lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm') }, true);
      try {
        const blob = await (await fetch(abs('lab/models/tiny-test.gguf'))).blob();
        const bounded = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('WASM smoke test exceeded 45 seconds')), 45000))]);
        await bounded(w.loadModel([blob], { n_ctx: 2048, n_threads: 1, n_gpu_layers: 0, n_batch: 32, n_ubatch: 32, n_parallel: 1, warmup: false }));
        const out = await bounded(w.createCompletion({ prompt: 'Hello', max_tokens: 8, temperature: 0, stream: false }));
        return { modelBytes: blob.size, text: out.choices?.[0]?.text, offline: !navigator.onLine };
      } finally { await w.exit(); }
    });
    assert.ok(result.modelBytes > 0);
    assert.ok(result.text?.length > 0);
    if (engine === 'chromium') assert.ok(result.offline);
    console.log('PASS: origin disconnected, one-thread CPU compatibility WASM inference:', JSON.stringify(result));
    serving = false;
    for (const path of ['memory.html', 'lab/index.html']) {
      await page.goto(url(path));
      assert.ok((await page.locator('h1').innerText()).length);
      console.log('PASS: offline navigation:', path);
    }
    assert.deepEqual(errors, []);
    console.log(env.opfs ? 'OPFS API available (persistence needs a separate test).' : 'LIMIT: Windows WebKit lacks OPFS. Model persistence must be verified in Safari on iOS/macOS.');
    console.log('LIMIT: Device emulation is not iPhone 17 RAM/GPU or iOS process-kill emulation.');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
