const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createMediaExperiences, redact } = require('../src/services/mediaExperiences');

test('experiences persist, deduplicate, search literally and retain corrections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-experiences-'));
  const file = path.join(root, 'test.db'); let db = new Database(file);
  try {
    let service = createMediaExperiences(db);
    const note = { request_key:'case-one', title:'时间线 镜头', summary:'50% opacity_safe', module_id:'local.video.compose-clips', source:'user_note', guidance:{method:'先校验各素材的起止点'}, quality_status:'partial' };
    const one = service.recordNote(note);
    assert.equal(service.recordNote(note).id, one.id);
    assert.equal(service.recordNote(note).reused, true);
    assert.throws(() => service.recordNote({...note,summary:'changed'}), {code:'EXPERIENCE_REQUEST_CONFLICT'});
    assert.equal(service.list({q:'时间线 镜头'}).total, 1);
    assert.equal(service.list({q:'50%'}).total, 1);
    assert.equal(service.list({q:"%' OR 1=1 --"}).total, 0);
    assert.equal(service.list({q:'opacity_'}).items[0].guidance, undefined);
    const two = service.recordNote({...note,request_key:'correct-one',summary:'已核对切点',quality_status:'passed',supersedes_id:one.id});
    assert.deepEqual(service.get(one.id).superseded_by, [two.id]);
    assert.equal(service.get(one.id).quality_status, 'partial');
    assert.equal(service.get(two.id).source, 'user_note');
    db.close(); db = new Database(file); service = createMediaExperiences(db);
    assert.equal(service.list({module_id:note.module_id,limit:1}).total, 2);
    assert.equal(service.list({limit:1,offset:1}).items.length, 1);
    assert.equal(service.get(two.id).guidance.method, note.guidance.method);
    assert.throws(() => service.recordNote({...note,request_key:'wrong',supersedes_id:'absent'}), {code:'EXPERIENCE_NOT_FOUND'});
    assert.throws(() => service.recordNote({...note,source:'system_receipt'}), {code:'EXPERIENCE_SOURCE_INVALID'});
  } finally { db.close(); fs.rmSync(root, {recursive:true,force:true}); }
});

test('credentials and signed URLs never enter records or the searchable index', () => {
  const db = new Database(':memory:');
  try {
    const service = createMediaExperiences(db);
    const record = service.recordNote({request_key:'redaction',title:'上传失败',
      summary:'api_key="fake-secret-value"\nCookie: sid=cookie-one; session=cookie-two\nAuthorization: Bearer shortvalue',
      context:{api_key:'secret-a',Authorization:'secret-b',Cookie:'secret-c',nested:{access_token:'secret-d'},
        'X-API-Key':'secret-header','x-amz-security-token':'secret-aws',proxyAuthorization:'secret-proxy',
        bare_url:'cdn.example.com/obj?X-Amz-Signature=secret-bare&X-Amz-Credential=secret-credential',
        message:'{"api_key": "secret-e"}', url:'https://name:pass@example.com/image?X-Amz-Signature=secret-f&token=secret-g#secret-h',
        media:'data:image/png;base64,aGVsbG8='},
      evidence_refs:['https://example.com/result?token=secret-i'],
    });
    const persisted = JSON.stringify(db.prepare('SELECT * FROM media_experiences').all());
    for (const value of ['fake-secret-value','cookie-one','cookie-two','shortvalue','secret-a','secret-b','secret-c','secret-d','secret-e','secret-f','secret-g','secret-h','secret-i','name:pass','aGVsbG8=','secret-header','secret-aws','secret-proxy','secret-bare','secret-credential']) assert.equal(persisted.includes(value), false, value);
    assert.equal(record.context.url, 'https://example.com/image');
    assert.equal(service.list({q:'cookie-one'}).total, 0);
    assert.equal(redact('原始错误 video_generation_failed'), '原始错误 video_generation_failed');
  } finally { db.close(); }
});

test('automatic experiences retain creative-text fingerprints instead of copying the prompt', () => {
  const db = new Database(':memory:');
  try {
    const service = createMediaExperiences(db), prompt = '用户完整创意不应被自动复制到另一份经验中';
    const record = service.recordJob({id:'prompt-job',session_id:'session',status:'succeeded',attempt:1,
      request:{module_id:'local.video.reverse-compose',parameters:{prompt,shots:[{description:prompt,source:2}],fps:24}}});
    assert.equal(JSON.stringify(record).includes(prompt),false);
    assert.equal(record.context.parameters.prompt.character_count,[...prompt].length);
    assert.equal(record.context.parameters.prompt.sha256.length,64);
    assert.equal(record.context.parameters.shots[0].source,2);
    assert.equal(record.context.parameters.fps,24);
  } finally { db.close(); }
});

test('system receipts capture evidence without inferring quality or failure cause', () => {
  const db = new Database(':memory:');
  try {
    const service = createMediaExperiences(db);
    const job = {id:'job-one',session_id:'session-one',attempt:1,status:'failed',operation_title:'剪辑',request:{module_id:'local.video.compose-clips',parameters:{}},error:{code:'INPUT_CHANGED',message:'素材发生变化'}};
    const failed = service.recordJob(job);
    assert.equal(failed.source, 'system_receipt');
    assert.equal(failed.quality_status, 'not_reviewed');
    assert.deepEqual(failed.guidance, {});
    assert.equal(service.recordJob(job).reused, true);
    const succeeded = service.recordJob({...job,status:'succeeded',attempt:2,result:{input_sha256:'input',output_sha256:'output',output_path:'/evidence/result.mp4',details:{quality_status:'passed'}}});
    assert.equal(succeeded.quality_status, 'not_reviewed');
    assert.equal(succeeded.context.output_sha256, 'output');
    assert.equal(succeeded.error, null);
    assert.equal(service.list({session_id:job.session_id}).total, 2);
    assert.equal(service.list({technical_status:'failed'}).total, 1);
  } finally { db.close(); }
});

test('large timeline receipts keep bounded searchable evidence and the original job pointer', () => {
  const db = new Database(':memory:');
  try {
    const service = createMediaExperiences(db);
    const sources = Array.from({length:64}, (_,i) => ({role:'clip',path:`/media/${i}.mp4`,sha256:String(i).padStart(64,'0')}));
    const job = {id:'large-job',session_id:'timeline-session',attempt:1,status:'succeeded',
      request:{module_id:'local.video.compose-clips',parameters:{clips:Array.from({length:256}, (_,i) => ({source:i%64,source_in:0,source_out:1,description:'detail '.repeat(20)}))},sources},
      result:{sources,output_path:'/media/result.mp4',output_sha256:'result'}};
    const record = service.recordJob(job);
    assert.equal(record.job_id, job.id);
    assert.equal(record.quality_status, 'not_reviewed');
    assert.equal(record.context.parameters.full_parameters, 'see original local media job');
    assert.equal(record.context.parameters.sha256.length,64);
    assert.equal(record.context.sources.length,24);
    assert.equal(record.context.sources_count,64);
    assert.equal(service.recordJob(job).id,record.id);
    assert.equal(service.list({session_id:job.session_id}).total,1);
    assert.ok(JSON.stringify(record).length < 32000);
  } finally { db.close(); }
});
