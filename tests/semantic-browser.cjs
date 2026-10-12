// Opt-in real e5 online preparation followed by an offline browser restart.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, {'Content-Type': ({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css'})[path.extname(file)] || 'application/octet-stream'}).end(body);
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await pw.chromium.launch({channel:'chrome'});
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('request', req => { if (!req.url().includes('127.0.0.1')) console.log('REQUEST', req.url().split('?')[0]); });
    page.on('console', msg => { if (msg.type()==='error') console.log('ERROR', msg.text().slice(0,200)); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('#offline').textContent.includes('保存済み'));
    async function embed() {
      return page.evaluate(async () => {
        const provider=AI.embed.transformersProvider(AI.embed.PACKS[0]);
        try {
          await provider.prepare();
          const vectors=await provider.embed(['猫が眠っている'], 'query');
          return {dim:vectors[0].length, norm:Math.hypot(...vectors[0])};
        } finally { await provider.unload(); }
      });
    }
    console.log('ONLINE', await embed());
    await page.locator('#open-menu').click();
    await page.locator('#network-mode').selectOption('offline');
    await page.waitForFunction(() => AI.net.isOffline());
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#prepare').disabled);
    const result=await embed();
    assert.equal(result.dim,384);assert.ok(Math.abs(result.norm-1)<0.01);
    console.log('PASS offline e5 after page reload', result);
  } finally { await browser?.close(); server.closeAllConnections(); server.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
