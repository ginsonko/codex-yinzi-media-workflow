const { test } = require('node:test');
const assert = require('node:assert/strict');
const { textPlacement } = require('../src/services/localSearchablePdfOperation');
const { contracts } = require('../src/services/localMediaOperations');

test('OCR quadrilateral placement converts top-left image coordinates to PDF coordinates', () => {
  assert.deepEqual(textPlacement({ box: [[10, 20], [110, 20], [110, 40], [10, 40]] }, 500),
    { x: 10, y: 460, width: 100, height: 20, angle: -0, origin: [10, 20], x_axis: [100, 0], y_axis: [0, 20] });
  const rotated = textPlacement({ box: [[10, 20], [110, 120], [90, 140], [-10, 40]] }, 500);
  assert.equal(rotated.angle, -45);
  assert.equal(rotated.width, Math.hypot(100, 100));
  assert.throws(() => textPlacement({ box: [[0, 0], [0, 0], [0, 0], [0, 0]] }, 500), { code: 'OCR_INVALID_BOX' });
  assert.throws(() => textPlacement({ box: [[NaN, 0]] }, 500), { code: 'OCR_INVALID_BOX' });
});

test('search layer covers skewed OCR bounds without extending the selected region', () => {
  const boxes = [
    [[501,254],[730,256],[730,263],[501,265]],
    [[62,762],[118,768],[116,788],[61,783]],
    [[10,20],[110,120],[90,140],[-10,40]],
    [[10,10],[100,30],[115,60],[25,40]],
  ];
  for (const box of boxes) {
    const placement = textPlacement({ box }, 1000);
    const corners = [[0,0],[1,0],[1,1],[0,1]].map(([x,y]) => placement.origin.map((v,i) => v + x * placement.x_axis[i] + y * placement.y_axis[i]));
    for (const axis of [0,1]) for (const bound of [Math.min,Math.max]) {
      assert.ok(Math.abs(bound(...corners.map(p => p[axis])) - bound(...box.map(p => p[axis]))) < 1e-8);
    }
  }
  assert.throws(() => textPlacement({ box: [[0,0],[10,0],[20,0],[30,0]] }, 100), { code: 'OCR_INVALID_BOX' });
});

test('searchable PDF declares its shared OCR dependency without adding PDF to plain text OCR', () => {
  const list = contracts();
  const pdf = list.find(item => item.module_id === 'local.image.searchable-pdf');
  assert.equal(pdf.component_id, 'document.pdf');
  assert.deepEqual(pdf.additional_components, ['vision.ocr']);
  assert.deepEqual(list.find(item => item.module_id === 'local.image.ocr').additional_components, []);
  assert.equal(pdf.validation_status, 'execution_receipt_required');
});
