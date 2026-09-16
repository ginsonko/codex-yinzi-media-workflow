const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeSegments,settings}=require('../src/services/audioTranscribe');
const cue=(from,to,text='hello')=>({offsets:{from,to},text});
test('subtitle normalization preserves timing and clips only before timeline origin',()=>{
 const r=normalizeSegments([cue(0,400),cue(400,1100),cue(1100,1900)],-800);
 assert.deepEqual(r.map(s=>[s.start_ms,s.end_ms]),[[0,300],[300,1100]]);
 assert.deepEqual(normalizeSegments([cue(0,500)],-1000),[]);
 assert.equal(normalizeSegments([cue(50,800)],400)[0].start_ms,450);
});
test('invalid transcription structures and unordered or nonfinite times fail visibly',()=>{
 for(const invalid of [undefined,{},[cue(NaN,100)],[cue(100,90)],[cue(0,0)],[cue(0,500),cue(400,800)],[{text:'missing',timestamps:{from:'bad',to:'00:00:01,000'}}]])
  assert.throws(()=>normalizeSegments(invalid,0),{code:'AUDIO_TRANSCRIBE_INVALID_TIMESTAMPS'});
 assert.throws(()=>normalizeSegments([{text:{},offsets:{from:0,to:10}}],0),{code:'AUDIO_TRANSCRIBE_OUTPUT_PARSE_FAILED'});
});
test('speech language and explicit false remain unchanged; quiet speech can disable filtering',()=>{
 assert.equal(settings({language:'auto',translate:'false'}).translate,false);
 assert.equal(settings({language:'auto'}).language,'auto');
 assert.equal(settings({silence_threshold_db:null}).silence_threshold_db,null);
 assert.throws(()=>settings({translate:'sometimes'}),{code:'AUDIO_TRANSCRIBE_INVALID_TRANSLATE'});
});
