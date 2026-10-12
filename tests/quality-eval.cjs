// Opt-in actual inference, with local GGUF files or a local llama-server.
// QUALITY_MODEL=path.gguf[,shard2.gguf] or QUALITY_NATIVE=http://127.0.0.1:18184
// QUALITY_OUTPUT=report.json, QUALITY_SYSTEM=experimental instruction (optional).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const { QUALITY_CASES } = await import('./quality-cases.mjs');
  const ids = (process.env.QUALITY_CASES || '').split(',').filter(Boolean);
  const cases = QUALITY_CASES.filter(c => !ids.length || ids.includes(c.id));
  if (!cases.length) throw new Error('No matching quality cases.');
  const { PROFILES, buildConversation } = await import('../js/conversation-core.mjs');
  const rows = [];
  const output = path.resolve(process.env.QUALITY_OUTPUT || path.join(__dirname, '.cache/quality/results.json'));
  const thinking = process.env.QUALITY_THINK === '1';
  const options = { max_tokens: thinking ? 768 : 160, temperature: thinking ? 0.6 : 0.1, seed: 42, chat_template_kwargs: { enable_thinking: thinking } };
  function record(row) {
    rows.push(row);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const expectedTurns = cases.reduce((n, c) => n + c.turns.length, 0);
    fs.writeFileSync(output, JSON.stringify({ model: process.env.QUALITY_MODEL || 'see local server startup', engine: process.env.QUALITY_NATIVE || 'wllama 3.6.1 CPU compat', system: process.env.QUALITY_SYSTEM || 'production', options, expectedTurns, complete: rows.length === expectedTurns, rows }, null, 2));
    console.log(JSON.stringify(row));
  }
  if (process.env.QUALITY_NATIVE) {
    const base = new URL(process.env.QUALITY_NATIVE);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Only a local evaluation server is allowed.');
    for (const item of cases) {
      const history = [];
      for (const query of item.turns) {
        const messages = buildConversation(query, history, item.memories || [], { ...PROFILES.mobile, output: options.max_tokens, noThink: !thinking });
        if (process.env.QUALITY_SYSTEM) messages[0].content = process.env.QUALITY_SYSTEM + (messages.referenceText ? '\n参考資料:\n' + messages.referenceText : '');
        const start = performance.now();
        const response = await fetch(new URL('/v1/chat/completions', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...options, messages }), signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        const answer = data.choices?.[0]?.message?.content || '';
        record({ id: item.id, query, messages, answer, finish: data.choices?.[0]?.finish_reason, seconds: (performance.now()-start)/1000, usage: data.usage, rubric: item.rubric });
        history.push({ q: query, a: answer });
      }
    }
    return;
  }
  const files = (process.env.QUALITY_MODEL || '').split(',').filter(Boolean).map(f => path.resolve(root, f));
  if (!files.length || files.some(f => !fs.existsSync(f))) throw new Error('Set QUALITY_MODEL to existing local GGUF files.');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Isolated quality evaluation</title>');
    const model = /^\/quality-model-(\d+)\.gguf$/.exec(pathname);
    const file = model ? files[Number(model[1])] : path.resolve(root, '.' + (pathname === '/' ? '/tests/quality.html' : pathname));
    if (!file || (!model && !file.startsWith(root + path.sep))) return res.writeHead(403).end();
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': ({ '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.wasm':'application/wasm' })[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    await page.exposeFunction('recordQuality', record);
    page.on('console', msg => { if (msg.text().startsWith('BENCH')) console.log(msg.text()); });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async ({ count, options, system, cases }) => {
      const { Wllama, LoggerWithoutDebug } = await import('/lab/vendor/wllama-3.6.1/index.js');
      const { configureRuntime } = await import('/js/runtime-compat.mjs');
      const { PROFILES, buildConversation } = await import('/js/conversation-core.mjs');
      const w = new Wllama({ default: location.origin + '/lab/vendor/wllama-3.6.1/wasm/wllama.wasm' }, { logger: LoggerWithoutDebug });
      configureRuntime(w, { worker: location.origin + '/lab/vendor/wllama-compat-3.6.1/wasm/wllama.js', wasm: location.origin + '/lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm' }, true);
      try {
        const blobs = [];
        for (let i = 0; i < count; i++) blobs.push(await fetch(`/quality-model-${i}.gguf`).then(r => r.blob()));
        await w.loadModel(blobs, { n_ctx: 2048, n_gpu_layers: 0, n_threads: 1, n_batch: 32, n_ubatch: 32, n_parallel: 1, warmup: false, default_template_kwargs: { enable_thinking: false } });
        console.log('BENCH model ready');
        for (const item of cases) {
          const history = [];
          for (const query of item.turns) {
            const messages = buildConversation(query, history, item.memories || [], { ...PROFILES.mobile, output: options.max_tokens, noThink: !options.chat_template_kwargs.enable_thinking });
            if (system) messages[0].content = system + (messages.referenceText ? '\n参考資料:\n' + messages.referenceText : '');
            const start = performance.now(); let answer = '', finish;
            const stream = await w.createChatCompletion({ ...options, messages, stream: true });
            for await (const chunk of stream) {
              answer += chunk.choices?.[0]?.delta?.content || '';
              finish = chunk.choices?.[0]?.finish_reason || finish;
            }
            await window.recordQuality({ id: item.id, query, messages, answer, finish, seconds: (performance.now()-start)/1000, rubric: item.rubric });
            history.push({ q: query, a: answer });
          }
        }
      } finally { await w.exit(); }
    }, { count: files.length, options, system: process.env.QUALITY_SYSTEM || '', cases });
  } finally { await browser?.close(); server.closeAllConnections(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
