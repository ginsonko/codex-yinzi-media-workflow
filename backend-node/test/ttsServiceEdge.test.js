const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { edgeTtsArgs, synthesizeWithEdge } = require('../src/services/ttsService');

describe('Edge TTS process boundary', () => {
  it('passes voice, rate, text and output as separate argv entries', () => {
    const text = '旁白；$(不会执行) `也不会执行`';
    const args = edgeTtsArgs(text, 'zh-CN-XiaoyiNeural', '+10%');
    assert.deepEqual(args, [
      '--voice', 'zh-CN-XiaoyiNeural', '--rate', '+10%', '--text', text, '--write-media',
    ]);
  });

  it('uses the bundled Node client and returns the generated mp3 bytes', async () => {
    let received = null;
    class FakeEdgeTTS {
      constructor(options) { received = { options }; }
      async ttsPromise(text, outputPath) {
        received.text = text;
        fs.writeFileSync(outputPath, Buffer.alloc(1024, 7));
      }
    }
    const result = await synthesizeWithEdge('测试旁白', 'zh-CN-XiaoyiNeural', 1.1, { EdgeTTS: FakeEdgeTTS });
    assert.equal(result.length, 1024);
    assert.equal(received.text, '测试旁白');
    assert.equal(received.options.voice, 'zh-CN-XiaoyiNeural');
    assert.equal(received.options.rate, '+10%');
  });

  it('reports that Edge Neural needs network access', async () => {
    class OfflineEdgeTTS {
      async ttsPromise() { throw new Error('ECONNRESET'); }
    }
    await assert.rejects(
      () => synthesizeWithEdge('测试旁白', 'zh-CN-XiaoyiNeural', 1, { EdgeTTS: OfflineEdgeTTS }),
      /在线语音连接失败，请检查网络/
    );
  });
});
