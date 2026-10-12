const { test, equal, ok } = window.T;

test('isolation: deleting copied-app models preserves the original model cache', async () => {
  const stores = new Map([
    ['transformers-cache', new Map([['https://huggingface.co/a/b/model.onnx', 1]])],
    [AI.store.MODEL_CACHE, new Map([['https://huggingface.co/a/b/model.onnx', 2]])],
  ]);
  const fake = {
    has: async (name) => stores.has(name),
    open: async (name) => ({
      keys: async () => [...stores.get(name).keys()].map((url) => ({ url })),
      delete: async (request) => stores.get(name).delete(request.url),
    }),
  };
  equal(await AI.store.removeModel('a/b', fake), 1);
  equal(stores.get('transformers-cache').size, 1);
  equal(stores.get(AI.store.MODEL_CACHE).size, 0);
});

async function serviceWorkerHarness(fakeCaches, fakeFetch) {
  const source = await (await fetch('../sw.js')).text();
  const handlers = {};
  const self = {
    location: new URL('../', location.href),
    addEventListener: (name, fn) => { handlers[name] = fn; },
    clients: { claim: async () => {} },
  };
  new Function('self', 'caches', 'fetch', 'URL', source)(self, fakeCaches, fakeFetch, URL);
  return handlers;
}

test('isolation: service-worker cleanup only removes copied-app versions', async () => {
  const removed = [];
  const names = ['ai-0.11.3', 'ai-0.11.4', 'ai-lib-1', 'transformers-cache',
    'ai-safari-app-0.11.4', 'ai-safari-app-0.12.9', AI.store.LIB_CACHE, AI.store.MODEL_CACHE];
  const handlers = await serviceWorkerHarness({
    keys: async () => names,
    delete: async (name) => { removed.push(name); return true; },
  });
  let work;
  handlers.activate({ waitUntil: (promise) => { work = promise; } });
  await work;
  equal(removed, ['ai-safari-app-0.11.4']);
});

test('isolation: offline navigation reads this app cache, not another app', async () => {
  const opened = [];
  const handlers = await serviceWorkerHarness({
    open: async (name) => {
      opened.push(name);
      return { match: async () => new Response('copied-app') };
    },
    match: async () => { throw new Error('Global cache lookup would mix apps'); },
  }, async () => { throw new Error('offline'); });
  let response;
  handlers.fetch({
    request: { method: 'GET', mode: 'navigate', url: new URL('../index.html', location.href).href },
    respondWith: (promise) => { response = promise; },
  });
  equal(await (await response).text(), 'copied-app');
  equal(opened, ['ai-safari-app-0.12.9']);
});
