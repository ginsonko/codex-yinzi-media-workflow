const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {transitions}=require('../src/services/videoTransitions');

test('published previews match the supported transition IDs and immutable media bytes',()=>{
  const root=path.join(__dirname,'../../frontweb/public/transition-previews');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.count,transitions.length);
  assert.deepEqual(manifest.previews.map(p=>p.id).sort(),transitions.map(t=>t.id).sort());
  for(const entry of manifest.previews){
    assert.equal(entry.file,entry.id+'.mp4');
    const bytes=fs.readFileSync(path.join(root,entry.file));
    assert.ok(bytes.length>0);assert.equal(bytes.length,entry.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);
    assert.equal(bytes.toString('ascii',4,8),'ftyp');
  }
});
