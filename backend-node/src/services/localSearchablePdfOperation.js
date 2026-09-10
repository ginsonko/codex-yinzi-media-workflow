const fs = require('node:fs');
const path = require('node:path');
const { recognize } = require('./localOcrOperation');

function textPlacement(line, pageHeight) {
  const box = line.box;
  if (!Array.isArray(box) || box.length !== 4 || box.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value)))) {
    throw Object.assign(Error('文字位置数据无效，无法生成准确的搜索层'), { code: 'OCR_INVALID_BOX' });
  }
  const [topLeft, topRight, bottomRight, bottomLeft] = box;
  const width = Math.hypot(topRight[0] - topLeft[0], topRight[1] - topLeft[1]);
  const height = Math.hypot(bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1]);
  if (!(width > 0 && height > 0)) throw Object.assign(Error('文字区域尺寸无效'), { code: 'OCR_INVALID_BOX' });
  // OCR can return trapezoids. Fit both opposite edges, retaining shear and rotation.
  const xAxis = topLeft.map((value, i) => (topRight[i] - value + bottomRight[i] - bottomLeft[i]) / 2);
  const yAxis = topLeft.map((value, i) => (bottomLeft[i] - value + bottomRight[i] - topRight[i]) / 2);
  const determinant = xAxis[0] * yAxis[1] - xAxis[1] * yAxis[0];
  if (!(determinant > 0)) throw Object.assign(Error('文字区域四角顺序或面积无效'), { code: 'OCR_INVALID_BOX' });
  const minimum = [0, 1].map(axis => Math.min(...box.map(point => point[axis])));
  const maximum = [0, 1].map(axis => Math.max(...box.map(point => point[axis])));
  const origin = [0, 1].map(axis => {
    const scale = (maximum[axis] - minimum[axis]) / (Math.abs(xAxis[axis]) + Math.abs(yAxis[axis]));
    xAxis[axis] *= scale;
    yAxis[axis] *= scale;
    return minimum[axis] - Math.min(0, xAxis[axis], yAxis[axis], xAxis[axis] + yAxis[axis]);
  });
  return { x: bottomLeft[0], y: pageHeight - bottomLeft[1], width, height, angle: -Math.atan2(xAxis[1], xAxis[0]) * 180 / Math.PI,
    origin, x_axis: xAxis, y_axis: yAxis };
}

async function processFile({ inputPath, outputPath, requireComponent, requireComponents, componentDir }) {
  const ocrRequire = requireComponents['vision.ocr'];
  const recognition = await recognize({ inputPath, requireComponent: ocrRequire });
  const PDFDocument = requireComponent('pdfkit');
  const sharp = ocrRequire('sharp');
  const raster = await sharp(inputPath, { failOn: 'error', limitInputPixels: 40000000 }).png().toBuffer();
  const sourceImage = recognition.before;
  const doc = new PDFDocument({ size: [sourceImage.width, sourceImage.height], margin: 0, info: { Producer: 'Yinzi Media Workflow / PDFKit' } });
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', resolve); doc.on('error', reject); });
  doc.image(raster, 0, 0, { width: sourceImage.width, height: sourceImage.height });
  doc.font(path.join(componentDir, 'fonts/NotoSansCJKsc-Regular.otf'));
  const placements = [];
  for (const line of recognition.lines) {
    if (!line.text.trim()) continue;
    const placement = textPlacement(line, sourceImage.height);
    doc.fontSize(1);
    const textWidth = Math.max(doc.widthOfString(line.text), 0.001);
    const textHeight = doc.currentLineHeight(false);
    doc.save().transform(placement.x_axis[0] / textWidth, placement.x_axis[1] / textWidth,
      placement.y_axis[0] / textHeight, placement.y_axis[1] / textHeight, ...placement.origin);
    doc.fillOpacity(0).text(line.text, 0, 0, { lineBreak: false });
    doc.restore();
    placements.push({ ...placement, text: line.text, size: 1, mapping: 'affine_ocr_quad_bounds' });
  }
  doc.end();
  await done;
  fs.writeFileSync(outputPath, Buffer.concat(chunks));
  return { ...recognition, after: { format: 'pdf', page_count: 1, width: sourceImage.width, height: sourceImage.height, text_regions: placements.length },
    text_placements: placements, quality_note: '原图已保留在PDF页面，搜索文字由OCR提取；人名、数字和模糊字符需对照原图核对。' };
}

module.exports = { id: 'local.image.searchable-pdf', title: '图片转可搜索PDF', kind: 'document', component_id: 'document.pdf',
  additional_components: ['vision.ocr'], output_extension: 'pdf', defaults: {}, processFile, textPlacement, source: 'https://pdfkit.org/' };
