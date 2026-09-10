const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {sourceFingerprints}=require('../src/services/localMediaValidation');
const {operations:allOperations}=require('../src/services/localMediaOperations');
const operations=allOperations.filter(op=>['media.ffmpeg','media.sharp'].includes(op.component_id));
const root=path.resolve(process.argv[2]),summary=JSON.parse(fs.readFileSync(path.join(root,'acceptance.json')));
const normalized=sourceFingerprints();
for(const [file,digest] of Object.entries(normalized)){
 const raw=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../src/services',file))).digest('hex');
 assert.ok([raw,digest].includes(summary.source_fingerprints?.[file]),'source changed after actual acceptance: '+file);
}
assert.equal(summary.results.length,operations.length);assert.equal(summary.passed,operations.length);
const results=operations.map(op=>{const row=summary.results.find(item=>item.id===op.id);assert.equal(row?.status,'passed');const receipt=JSON.parse(fs.readFileSync(row.receipt));assert.ok(fs.existsSync(receipt.output_path));return{id:op.id,title:op.title,status:row.status,component_id:receipt.component_id,component_version:receipt.component_version,input_sha256:receipt.input_sha256,output_sha256:receipt.output_sha256,bytes:receipt.bytes,parameters:receipt.parameters,verified_at:receipt.verified_at};});
const report={schema_version:1,status:'passed',platform:'win32-x64',at:summary.at,total:results.length,source_fingerprints:normalized,fingerprint_normalization:'UTF-8 with CRLF normalized to LF; observed source matched before normalization',components:summary.registered_components,scope:'Generated 160x96 one-second video/audio/image fixtures; real component execution, source preservation and output decoding. This is not semantic AI character replacement or arbitrary-input certification.',operations:results};
const target=path.resolve(__dirname,'../components/acceptance-windows-x64.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');console.log('Exported',results.length,'verified receipts without local paths');
