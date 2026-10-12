// Service Worker：アプリ本体をキャッシュして、電波が無くても開けるようにする。
// VERSION は index.html のスクリプトの ?v= と同じにする（tests で食い違いを検出）。
// 外部（Wikipedia など）の通信はここでは扱わない。同じオリジンのファイルだけを対象にする。
const VERSION = '0.12.6';
const CACHE = `ai-safari-app-${VERSION}`;
const FILES = [
  './index.html',
  './memory.html',
  './conversation.css',
  './js/conversation.mjs',
  './js/conversation-core.mjs',
  './js/runtime-compat.mjs',
  './lab/index.html',
  './lab/storage.js',
  './lab/vendor/wllama-3.6.1/index.js',
  './lab/vendor/wllama-3.6.1/wasm/wllama.wasm',
  './lab/vendor/wllama-compat-3.6.1/wasm/wllama.js',
  './lab/vendor/wllama-compat-3.6.1/wasm/wllama.wasm',
  './lab/models/tiny-test.gguf',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  ...['normalize', 'db', 'terms', 'chat', 'wiki', 'passages', 'feedback', 'net', 'queue', 'backup', 'store', 'embed', 'llm', 'rag', 'growth', 'sentiment', 'vectors', 'hybrid', 'app'].map(
    (n) => `./js/${n}.js?v=${VERSION}`
  ),
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

// この改修版のアプリキャッシュだけを更新する。元のaiとモデル保存先には触れない
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ai-safari-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const root = new URL('./', self.location.href);
  if (!url.pathname.startsWith(root.pathname)) return;
  // Navigation and JS come from the same installed version. A new worker is
  // activated only after every runtime asset has been cached successfully.
  if (request.mode === 'navigate') {
    const path = url.pathname === root.pathname ? './index.html' : '.' + url.pathname.slice(root.pathname.length - 1);
    if (!FILES.includes(path)) return;
    event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(path)) || fetch(request)));
    return;
  }

  // それ以外（版番号つきのJS・画像など）：キャッシュ優先
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(request)).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
