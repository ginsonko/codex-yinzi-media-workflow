const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: [200, 100], margin: 0 });
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', resolve); doc.on('error', reject); });
  doc.font(path.join(__dirname, 'fonts/NotoSansCJKsc-Regular.otf')).fontSize(14).text('中文 PDF', 10, 40, { lineBreak: false });
  doc.end();
  await done;
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw Error('PDF healthcheck output invalid');
  console.log(JSON.stringify({ engine: 'pdfkit', pages: 1, bytes: bytes.length, font: 'Noto Sans CJK SC' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
