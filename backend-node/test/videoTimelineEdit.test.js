const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateCuts}=require('../src/services/videoTimelineEdit');
test('edit preserves intentional shot order and refuses out-of-source or reversed ranges',()=>{
 assert.deepEqual(validateCuts([{start:5,end:7},{start:0,end:3}],10),[{start:5,end:7},{start:0,end:3}]);
 assert.throws(()=>validateCuts([{start:0,end:11}],10),/镜头终点/);
 assert.throws(()=>validateCuts([{start:4,end:2}],10),/晚于/);
 assert.throws(()=>validateCuts([],10),/cuts/);
});
