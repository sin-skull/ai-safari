// Opt-in real Qwen model comparison (~397 MB download). Uses an isolated browser.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      res.writeHead(200, {'Content-Type': ({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css'})[path.extname(file)] || 'application/octet-stream'});
      res.end(await fs.readFile(file));
    } catch (_) { res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({channel:'chrome', headless:true});
    const page = await browser.newPage();
    page.on('console', msg => { if (msg.text().startsWith('BENCH')) console.log(msg.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const results = await page.evaluate(async () => {
      const { Wllama, CacheManager, LoggerWithoutDebug } = await import('/lab/vendor/wllama-3.6.1/index.js');
      const { NamespacedOPFSBackend } = await import('/lab/storage.js');
      const { configureRuntime } = await import('/js/runtime-compat.mjs');
      const { PROFILES, buildConversation } = await import('/js/conversation-core.mjs');
      // Published Qwen non-thinking recommendation, compared rather than assumed better.
      const QWEN_SAMPLING = {temperature:0.7,top_p:0.8,top_k:20,min_p:0,presence_penalty:1.5};
      const profile = PROFILES.mobile;
      const w = new Wllama({default:location.origin+'/lab/vendor/wllama-3.6.1/wasm/wllama.wasm'}, {cacheManager:new CacheManager([new NamespacedOPFSBackend('ai-safari-quality-bench')]), logger:LoggerWithoutDebug});
      configureRuntime(w, {worker:location.origin+'/lab/vendor/wllama-compat-3.6.1/wasm/wllama.js',wasm:location.origin+'/lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm'}, true);
      let milestone = -1;
      const out = [];
      try {
        await w.loadModelFromUrl(profile.url, {n_ctx:2048,n_gpu_layers:0,n_threads:1,n_batch:32,n_ubatch:32,n_parallel:1,warmup:false,default_template_kwargs:{enable_thinking:false}, progressCallback:({loaded,total}) => { const m=Math.floor(loaded/total*10); if(m>milestone){milestone=m; console.log('BENCH download '+m*10+'%');} }});
        console.log('BENCH model ready');
        for (const query of ['猫を飼う前に用意するものを3つ、日本語で短く教えてください。', '今日は仕事で疲れた。短く返事して。']) {
          for (const [name, sampling] of [['old',{temperature:0.1}],['new',QWEN_SAMPLING]]) {
            const start = performance.now(); let answer='';
            const stream=await w.createChatCompletion({messages:buildConversation(query,[],[],profile), max_tokens:160, stream:true, seed:42, ...sampling, chat_template_kwargs:{enable_thinking:false}});
            for await (const chunk of stream) answer+=chunk.choices?.[0]?.delta?.content||'';
            const row={name, query, answer, seconds:(performance.now()-start)/1000};out.push(row); console.log('BENCH '+JSON.stringify(row));
          }
        }
        return out;
      } finally { await w.exit(); }
    });
    console.log(JSON.stringify(results,null,2));
  } finally { await browser?.close(); server.closeAllConnections(); server.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
