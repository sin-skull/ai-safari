// Run the existing logic tests without driving the user's browser.
// Browser-only OPFS/Worker checks remain in tests/test.html.
const fs = require('node:fs');
const vm = require('node:vm');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

const element = () => ({ appendChild() {}, textContent: '', className: '' });
const document = { getElementById: element, createElement: element };
const context = vm.createContext({
  indexedDB, IDBKeyRange, document, console, setTimeout, clearTimeout,
  URL, URLSearchParams, Response, Request, Blob, TextEncoder, TextDecoder,
  structuredClone, crypto: require('node:crypto').webcrypto,
  location: new URL('https://example.test/ai-safari/tests/test.html'),
  fetch: async (url) => {
    if (url === '../sw.js') return new Response(fs.readFileSync('sw.js', 'utf8'));
    throw new Error('Unexpected network request in tests: ' + url);
  },
});
context.window = context;
context.self = context;
const html = fs.readFileSync('tests/test.html', 'utf8');
for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const path = require('node:path').resolve('tests', match[1]);
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
(async () => {
  await context.T.run();
  const result = context.__testResults;
  for (const failure of result.results.filter((item) => !item.passed)) {
    console.error(failure.name + ': ' + failure.error);
  }
  console.log(result.total + ' logic tests; ' + result.failed + ' failed.');
  console.log('OPFS/Worker and device behavior require tests/test.html in a browser.');
  process.exitCode = result.failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
