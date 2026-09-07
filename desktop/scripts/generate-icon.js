'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const svg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="96" fill="#14372d"/>
  <path d="M96 146c0-22 18-40 40-40h240c22 0 40 18 40 40v220c0 22-18 40-40 40H136c-22 0-40-18-40-40V146z" fill="#f5f7f2"/>
  <path d="M96 178h320v58H96z" fill="#d9553e"/>
  <path d="M142 106l50 130h56l-50-130h-56zm116 0 50 130h56l-50-130h-56z" fill="#f0b84b"/>
  <path d="M216 277l96 58-96 58V277z" fill="#14372d"/>
  <circle cx="376" cy="365" r="28" fill="#d9553e"/>
</svg>`;

async function run() {
  const pngPath = path.join(buildDir, 'icon.png');
  await sharp(Buffer.from(svg)).png().toFile(pngPath);
  const pngToIcoModule = require('png-to-ico');
  const pngToIco = pngToIcoModule.default || pngToIcoModule;
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(sizes.map((size) => (
    sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
  )));
  const ico = await pngToIco(pngBuffers);
  if (!Buffer.isBuffer(ico) || ico.length < 6 || !ico.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) {
    throw new Error('Generated icon is not a valid Windows ICO file');
  }
  const count = ico.readUInt16LE(4);
  if (count !== sizes.length) throw new Error(`Generated icon has ${count} sizes instead of ${sizes.length}`);
  const actualSizes = [];
  for (let index = 0; index < count; index += 1) {
    const directoryOffset = 6 + index * 16;
    const width = ico.readUInt8(directoryOffset) || 256;
    const height = ico.readUInt8(directoryOffset + 1) || 256;
    const planes = ico.readUInt16LE(directoryOffset + 4);
    const bits = ico.readUInt16LE(directoryOffset + 6);
    const bytes = ico.readUInt32LE(directoryOffset + 8);
    const imageOffset = ico.readUInt32LE(directoryOffset + 12);
    if (width !== height || planes !== 1 || bits !== 32 || bytes < 40 || imageOffset + bytes > ico.length) {
      throw new Error(`Generated icon directory entry ${index} is invalid`);
    }
    const dibWidth = ico.readInt32LE(imageOffset + 4);
    const dibHeight = ico.readInt32LE(imageOffset + 8);
    if (dibWidth !== width || dibHeight !== height * 2) {
      throw new Error(`Generated icon bitmap ${index} does not match its directory size`);
    }
    actualSizes.push(width);
  }
  if (!sizes.every((size, index) => actualSizes[index] === size)) {
    throw new Error(`Generated icon size order is invalid: ${actualSizes.join(', ')}`);
  }
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log(`[icon] build/icon.png and ${sizes.join('/')}px Windows ICO generated`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
