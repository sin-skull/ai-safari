// node tests/pwa-update.cjs — requires Playwright and its WebKit browser.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  let nextVersion = false;
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      let body = await fs.readFile(file);
      const ext = path.extname(file);
      if (nextVersion && ['.html', '.js', '.mjs'].includes(ext)) body = Buffer.from(body.toString().replaceAll('0.12.7', '0.12.8-test'));
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' })[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const chromium = process.env.BROWSER_ENGINE === 'chromium';
    browser = await (chromium ? pw.chromium : pw.webkit).launch(chromium ? { channel: 'chrome' } : {});
    const context = await browser.newContext({ ...pw.devices['iPhone 13'] });
    const page = await context.newPage();
    const base = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#offline').textContent.includes('保存済み'));
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#prepare').disabled);
    await page.evaluate(async () => {
      const db = await AI.db.open();
      await AI.db.tx(db, 'settings', 'readwrite', t => AI.db.rq(t.objectStore('settings').put({ name: 'conversation-v1', value: [{q: '更新前の会話', a: '保存されています', at: 1}] })));
      db.close();
      await (await caches.open('model-preservation-test')).put('marker', new Response('saved-model'));
      if (navigator.storage?.getDirectory) {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ai-safari-conversation-models', { create: true });
        const file = await dir.getFileHandle('update-test-marker', { create: true });
        const stream = await file.createWritable(); await stream.write('saved-opfs-model'); await stream.close();
      }
      document.querySelector('#input').value = 'まだ送っていない文章';
    });
    nextVersion = true;
    await Promise.all([page.waitForEvent('load'), page.locator('#update-app').click()]);
    await page.waitForFunction(() => document.querySelector('footer').textContent.includes('0.12.8-test'));
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('更新前の会話'));
    assert.equal(await page.locator('#input').inputValue(), 'まだ送っていない文章');
    assert.equal(await page.evaluate(async () => (await (await caches.open('model-preservation-test')).match('marker')).text()), 'saved-model');
    if (chromium) assert.equal(await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ai-safari-conversation-models');
      return (await (await dir.getFileHandle('update-test-marker')).getFile()).text();
    }), 'saved-opfs-model');
    assert.ok(await page.evaluate(async () => (await caches.keys()).includes('ai-safari-app-0.12.8-test')));
    // Same-version update must still work as a reload/recovery action.
    await Promise.all([page.waitForEvent('load'), page.locator('#update-app').click()]);
    await page.waitForFunction(() => !document.querySelector('#prepare').disabled);
    await context.setOffline(true);
    await page.locator('#update-app').click();
    assert.match(await page.locator('#update-status').innerText(), /接続が必要/);
    assert.equal(await page.locator('#update-app').isEnabled(), true);
    assert.equal(await page.locator('#input').inputValue(), 'まだ送っていない文章');
    console.log(`PASS ${chromium ? 'Chromium' : 'WebKit'}: update installs a new version, preserves history/draft/model marker, supports same-version reload and offline retry.`);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
