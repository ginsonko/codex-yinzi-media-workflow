const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const imageService = require('../src/services/imageService');
const { callImageApi, getDefaultImageConfig, prepareReferenceImageForTransport } = require('../src/services/imageClient');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('image reference transport copies', () => {
  it('persists the selected image service and config snapshot before async execution', () => {
    const db = new Database(':memory:');
    const originalSetImmediate = global.setImmediate;
    try {
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};
      try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }

      global.setImmediate = () => ({ unref() {} });
      const created = imageService.create(db, { info() {}, warn() {}, error() {} }, {
        drama_id: 1,
        prompt: 'single storyboard frame',
        model: 'gpt-image-2',
        image_service_type: 'storyboard_image',
        image_config_id: 42,
        frame_type: 'production_storyboard',
      });
      const persisted = db.prepare(
        'SELECT model, image_service_type, image_config_id, frame_type FROM image_generations WHERE id = ?'
      ).get(created.id);

      assert.deepEqual(persisted, {
        model: 'gpt-image-2',
        image_service_type: 'storyboard_image',
        image_config_id: 42,
        frame_type: 'production_storyboard',
      });
      assert.equal(created.image_service_type, 'storyboard_image');
      assert.equal(created.image_config_id, 42);
    } finally {
      global.setImmediate = originalSetImmediate;
      db.close();
    }
  });

  it('bounds a local upload copy without changing the canonical asset', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-reference-transport-'));
    try {
      const imageDir = path.join(storageRoot, 'images');
      fs.mkdirSync(imageDir, { recursive: true });
      const sourcePath = path.join(imageDir, 'canonical.png');
      await sharp({
        create: { width: 2560, height: 1440, channels: 4, background: '#4b7f86' },
      }).png().toFile(sourcePath);
      const beforeHash = sha256(sourcePath);
      const records = [];
      const log = { info(message, fields) { records.push({ message, fields }); }, warn() {} };

      const transported = await prepareReferenceImageForTransport(
        'images/canonical.png',
        'http://127.0.0.1/static',
        storageRoot,
        log,
      );

      assert.match(transported, /^data:image\/jpeg;base64,/);
      const output = Buffer.from(transported.split(',')[1], 'base64');
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.width, 1920);
      assert.equal(metadata.height, 1080);
      assert.ok(output.length <= 2 * 1024 * 1024);
      assert.equal(sha256(sourcePath), beforeHash);
      assert.equal(records.length, 1);
      assert.equal(JSON.stringify(records).includes('base64'), false);
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it('passes a public reference URL through unchanged', async () => {
    const url = 'https://cdn.example.test/assets/reference.png';
    const transported = await prepareReferenceImageForTransport(
      url,
      'http://127.0.0.1/static',
      'C:/missing-storage-root',
    );
    assert.equal(transported, url);
  });

  it('sends bounded copies through the OpenAI-compatible GPT Image request path', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-image-reference-request-'));
    const db = new Database(':memory:');
    let server;
    try {
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};
      try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }

      const imageDir = path.join(storageRoot, 'images');
      fs.mkdirSync(imageDir, { recursive: true });
      const refs = [];
      const hashes = [];
      for (let index = 0; index < 3; index += 1) {
        const relativePath = `images/reference-${index + 1}.png`;
        const absolutePath = path.join(storageRoot, relativePath);
        await sharp({
          create: {
            width: 2560,
            height: 1440,
            channels: 4,
            background: { r: 50 + index * 30, g: 90, b: 120, alpha: 1 },
          },
        }).png().toFile(absolutePath);
        refs.push(relativePath);
        hashes.push(sha256(absolutePath));
      }

      let receivedBody;
      server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: [{ url: 'https://cdn.example.test/generated.png' }] }));
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const log = { info() {}, warn() {}, error() {} };
      aiConfigService.createConfig(db, log, {
        service_type: 'image',
        provider: 'yinzi',
        api_protocol: 'openai',
        name: 'local-gpt-image-test',
        base_url: `http://127.0.0.1:${address.port}`,
        endpoint: '/images/generations',
        api_key: 'test-only-key',
        model: ['gpt-image-2'],
        default_model: 'gpt-image-2',
        is_default: true,
      });

      const result = await callImageApi(db, log, {
        prompt: 'single continuous empty greenhouse scene',
        model: 'gpt-image-2',
        size: '2560x1440',
        image_gen_id: 9001,
        imageServiceType: 'image',
        reference_image_urls: refs,
        files_base_url: 'http://127.0.0.1/static',
        storage_local_path: storageRoot,
        user_negative_prompt: 'flowers, plants',
      });

      assert.equal(result.image_url, 'https://cdn.example.test/generated.png');
      assert.equal(receivedBody.size, '1536x1024');
      assert.equal(receivedBody.image.length, 3);
      assert.match(receivedBody.negative_prompt, /flowers, plants/);
      for (const dataUrl of receivedBody.image) {
        assert.match(dataUrl, /^data:image\/jpeg;base64,/);
        const payload = Buffer.from(dataUrl.split(',')[1], 'base64');
        const metadata = await sharp(payload).metadata();
        assert.ok(Math.max(metadata.width, metadata.height) <= 1920);
        assert.ok(payload.length <= 2 * 1024 * 1024);
      }
      refs.forEach((relativePath, index) => {
        assert.equal(sha256(path.join(storageRoot, relativePath)), hashes[index]);
      });
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it('pins an explicitly selected image config even when model names collide', async () => {
    const db = new Database(':memory:');
    let server;
    try {
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};
      try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
      const received = [];
      server = http.createServer((request, response) => {
        received.push({ authorization: request.headers.authorization, path: request.url });
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: [{ url: 'https://cdn.example.test/pinned.png' }] }));
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const log = { info() {}, warn() {}, error() {} };
      const assetConfig = aiConfigService.createConfig(db, log, {
        service_type: 'image', provider: 'yinzi', api_protocol: 'openai', name: 'asset-key',
        base_url: `http://127.0.0.1:${address.port}`, endpoint: '/images/generations',
        api_key: 'asset-key-secret', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_default: true,
      });
      const selectedStoryboardConfig = aiConfigService.createConfig(db, log, {
        service_type: 'storyboard_image', provider: 'yinzi', api_protocol: 'openai', name: 'storyboard-key',
        base_url: `http://127.0.0.1:${address.port}`, endpoint: '/images/generations',
        api_key: 'storyboard-key-secret', model: ['gpt-image-2'], default_model: 'gpt-image-2', is_default: true,
      });

      const result = await callImageApi(db, log, {
        prompt: 'single continuous storyboard frame', model: 'gpt-image-2', image_gen_id: 9010,
        imageServiceType: 'storyboard_image', image_config_id: selectedStoryboardConfig.id,
      });
      assert.equal(result.image_url, 'https://cdn.example.test/pinned.png');
      assert.equal(received.at(-1).authorization, 'Bearer storyboard-key-secret');
      assert.equal(received.at(-1).path, '/images/generations');
      assert.throws(
        () => getDefaultImageConfig(db, 'gpt-image-2', null, 'storyboard_image', assetConfig.id),
        /不能用于 storyboard_image/
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  });
});
