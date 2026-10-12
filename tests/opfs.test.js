import { NamespacedOPFSBackend } from '../lab/storage.js';
import { CacheManager } from '../lab/vendor/wllama-3.6.1/index.js';

const { test, equal } = window.T;

test('isolation: clearing the lab model cache preserves a separate OPFS directory', async () => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2);
  const originalBackend = new NamespacedOPFSBackend('ai-safari-test-original-' + suffix);
  const copiedBackend = new NamespacedOPFSBackend('ai-safari-test-copy-' + suffix);
  const original = new CacheManager([originalBackend]);
  const copied = new CacheManager([copiedBackend]);
  const metadata = { originalURL: 'https://example.test/model.gguf', originalSize: 3, etag: 'test' };
  try {
    equal(await copiedBackend.read("https://example.test/model.gguf"), null);
    const urlKey = await copied.getNameFromURL(metadata.originalURL);
    await copied.write(urlKey, new Blob(["url"]).stream(), metadata);
    equal(await (await copied.open(metadata.originalURL)).text(), "url");
    await original.write('model.gguf', new Blob(['old']).stream(), metadata);
    await copied.write('model.gguf', new Blob(['new']).stream(), metadata);
    equal(await (await original.open('model.gguf')).text(), 'old');
    equal(await (await copied.open('model.gguf')).text(), 'new');
    await copied.clear();
    equal(await copied.list(), []);
    equal(await (await original.open('model.gguf')).text(), 'old');
    // Reusing a filename must truncate the previous bytes.
    await original.write('model.gguf', new Blob(['x']).stream(), { ...metadata, originalSize: 1 });
    equal(await (await original.open('model.gguf')).text(), 'x');
  } finally {
    await original.clear();
    await copied.clear();
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(originalBackend.directory);
    await root.removeEntry(copiedBackend.directory);
  }
});

await T.run();
