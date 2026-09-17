const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate,layout}=require('../src/services/editablePresentation');
const physics=require('../examples/presentations/physics.json');
test('editable presentations accept distinct subjects and reject ambiguous XY data',()=>{
 assert.equal(validate(physics).slides.length,4);assert.equal(validate(require('../examples/presentations/reading-club.json')).slides.length,2);
 for(const patch of [{slides:[]},{theme:'unknown'},{colors:{accent:'url(x)'}}])assert.throws(()=>validate({...physics,...patch}),{code:'PRESENTATION_INPUT_INVALID'});
 const bad=structuredClone(physics);bad.slides[1].blocks[0].series.push({name:'bad',x:[0,2,3],y:[1,2,3]});assert.throws(()=>validate(bad),/共用横坐标/);
 const ragged=structuredClone(physics);ragged.slides[2].blocks[0].rows[0].pop();assert.throws(()=>validate(ragged),/列数/);
});
test('dense content is surfaced for visual revision instead of silently being called accepted',()=>{
 const spec=structuredClone(physics);spec.slides[0].blocks[0].paragraphs=['读'.repeat(600)];assert.ok(layout(spec).warnings.some(w=>w.slide===1));
 for(const page of layout(physics).pages)for(const box of page.boxes){assert.ok(box.x+box.w<=13.334);assert.ok(box.y+box.h<7.5);}
});
