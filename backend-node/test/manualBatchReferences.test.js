const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startHarness } = require('./helpers/manualBatchHarness');
const { hasLocalFfmpeg } = require('../src/utils/ffmpegPath');

test('manual multipart uploads reach distinct persisted batch items and actual local provider POSTs, then finish and retry', { skip:!hasLocalFfmpeg(), timeout:60000 }, async () => {
  const h = await startHarness();
  const json = async (route,body) => {const res=await fetch(h.base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const value=await res.json(); assert.ok(res.ok,JSON.stringify(value)); return value.data;};
  const upload = async (bytes,name,type) => {const form=new FormData();form.append('file',new Blob([bytes],{type}),name);const res=await fetch(h.base+'/api/v1/upload/reference-media',{method:'POST',body:form}); const value=await res.json();assert.equal(res.status,200,JSON.stringify(value));return value.data.local_path;};
  const waitBatch = async id => {for(let i=0;i<160;i++){const batch=await json('/api/v1/media-batches/'+id);if(['completed','failed','partial','needs_review'].includes(batch.status))return batch;await new Promise(r=>setTimeout(r,100));}throw new Error('batch timed out '+JSON.stringify(h.errors));};
  try {
    const aiConfig = require('../src/services/aiConfigService');
    const catalogConfig = aiConfig.createConfig(h.db, {info(){},warn(){}}, {service_type:'video',provider:'yinzi',api_protocol:'yinzi',name:'catalog-display-fixture',base_url:h.base+'/provider/v1',api_key:'local-fixture-only',model:['catalog-fixture'],default_model:'catalog-fixture',settings:JSON.stringify({model_catalog_snapshot:{models:[{model:'catalog-fixture',capabilities:{max_images:7,max_videos:3,roles:{image:['reference'],video:['reference'],audio:[]}}}]},model_capability_overrides:{'catalog-fixture':{max_audios:2}}})});
    const displayed = await json('/api/v1/ai-configs/'+catalogConfig.id+'/model-capabilities');
    assert.equal(displayed.models[0].capability.max_images,7,'display must include credential catalog, not just builtin');
    assert.equal(displayed.models[0].capability.max_audios,2,'local override precedes catalog');
    assert.equal(displayed.models[0].protocol,'yinzi');
    const [a,b,v,w]=await Promise.all([upload(h.fixtures.image,'a.png','image/png'),upload(h.fixtures.imageB,'b.png','image/png'),upload(h.fixtures.video,'clip.mp4','video/mp4'),upload(h.fixtures.audio,'voice.wav','audio/wav')]);
    const { createGeneration } = require('../src/routes/videos');
    const priorTasks = h.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count;
    assert.throws(() => createGeneration(h.db,{info(){},error(){}},{prompt:'invalid reference',reference_image_urls:42}), {code:'VALIDATION_ERROR'});
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count,priorTasks);
    const body={kind:'video',concurrency:2,idempotency_key:'manual-reference-chain',settings:{duration:3,aspect_ratio:'16:9'},items:[{prompt:'A mixed references',model:'manual-fixture-a',video_config_id:h.configs[0].id,reference_image_urls:a,reference_video_urls:[v],reference_audio_urls:[w]},{prompt:'B first and last',model:'manual-fixture-b',video_config_id:h.configs[1].id,duration:4,aspect_ratio:'9:16',first_frame_url:b,last_frame_url:a,reference_image_urls:[],reference_video_urls:[],reference_audio_urls:[]}]};
    const created=await json('/api/v1/media-batches',body);
    const done=await waitBatch(created.id);
    assert.equal(done.status,'completed',JSON.stringify({done,errors:h.errors}));
    assert.equal(h.submissions.length,2);assert.equal(done.items.length,2);
    const first=h.submissions.find(p=>p.model==='manual-fixture-a'),second=h.submissions.find(p=>p.model==='manual-fixture-b');
    assert.deepEqual(first.references.map(r=>r.type),['image','video','audio']);
    assert.deepEqual(second.references.map(r=>r.role),['first_frame','last_frame']);
    assert.equal(second.aspect_ratio,'9:16'); assert.equal(second.duration,4);
    assert.notEqual(first.references[0].data_url,second.references[0].data_url);
    assert.deepEqual(done.items[0].request.reference_audio_urls,[w]);
    assert.ok(done.items.every(item=>item.media_url && item.status==='completed'));
    const recovered=await json('/api/v1/media-batches',body);assert.equal(recovered.id,created.id);assert.equal(h.submissions.length,2);
    await json('/api/v1/media-batches/'+created.id+'/items/'+done.items[0].id+'/retry',{expected_attempt:done.items[0].attempt,request_key:'explicit-second-attempt'});
    const retried=await waitBatch(created.id);assert.equal(retried.status,'completed');assert.equal(h.submissions.length,3);
    assert.deepEqual(h.submissions[2].references,first.references);
  } finally { await h.close(); }
});

test('manual image items override shared references and sizes independently while legacy API defaults remain available', { timeout:30000 }, async () => {
  const received = [];
  const h = await startHarness({dispatchImage: request => {
    received.push(request);
    throw Object.assign(new Error('local image dispatch captured'), {code:'VALIDATION_ERROR',definitely_not_submitted:true});
  }});
  try {
    const upload = async (bytes,name) => {
      const form = new FormData(); form.append('file',new Blob([bytes],{type:'image/png'}),name);
      const res = await fetch(h.base+'/api/v1/upload/reference-media',{method:'POST',body:form});
      assert.equal(res.status,200); return (await res.json()).data.local_path;
    };
    const [a,b] = await Promise.all([upload(h.fixtures.image,'image-a.png'),upload(h.fixtures.imageB,'image-b.png')]);
    const res = await fetch(h.base+'/api/v1/media-batches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      kind:'image',idempotency_key:'image-reference-chain',settings:{aspect_ratio:'16:9',reference_images:[a]},
      items:[{prompt:'A',size:'2560x1440',reference_images:[a]},{prompt:'B',size:'3840x2160',reference_images:[b]}, {prompt:'C no references',size:'1280x720',reference_images:[]}, {prompt:'legacy shared',size:'1024x1024'}],
    })});
    assert.equal(res.status,201);
    for (let i=0; i<100 && received.length<4; i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(received.map(item=>item.reference_images),[[a],[b],[],[a]]);
    assert.deepEqual(received.map(item=>item.size),['2560x1440','3840x2160','1280x720','1024x1024']);
    assert.equal(received.every(item=>item.reference_image_urls===undefined),true);
  } finally { await h.close(); }
});
