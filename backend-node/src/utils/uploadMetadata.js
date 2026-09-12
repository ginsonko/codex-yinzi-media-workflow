const crypto = require('node:crypto');
const path = require('node:path');

// Transmission metadata only: never rename or re-encode the original media.
// Inspect a bounded prefix of bytes already read by the caller.
function sniffMedia(bytes) {
  const b = bytes.subarray(0, 4096);
  if (b.length >= 8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png','png'];
  if (b.length >= 3 && b[0]===255 && b[1]===216 && b[2]===255) return ['image/jpeg','jpg'];
  const head=b.toString('ascii',0,12);
  if (/^GIF8[79]a/.test(head)) return ['image/gif','gif'];
  if (head.startsWith('RIFF') && head.slice(8,12)==='WEBP') return ['image/webp','webp'];
  if (head.startsWith('RIFF') && head.slice(8,12)==='WAVE') return ['audio/wav','wav'];
  if (head.startsWith('fLaC')) return ['audio/flac','flac'];
  if (head.startsWith('ID3')) return ['audio/mpeg','mp3'];
  if (head.slice(4,8)==='ftyp') {
    const brand=head.slice(8,12);
    if (['avif','avis'].includes(brand)) return ['image/avif','avif'];
    if (['heic','heix','hevc','hevx'].includes(brand)) return ['image/heic','heic'];
    if (['mif1','msf1'].includes(brand)) return ['image/heif','heif'];
    if (['M4A ','M4B ','M4P '].includes(brand)) return ['audio/mp4','m4a'];
    if (brand==='qt  ') return ['video/quicktime','mov'];
    return ['video/mp4','mp4'];
  }
  return null;
}

function uploadMetadata(bytes, filename = 'reference', declaredMime = 'application/octet-stream') {
  if (!Buffer.isBuffer(bytes)) throw TypeError('uploadMetadata requires media bytes');
  const detected=sniffMedia(bytes);
  const knownExtension=path.extname(String(filename)).slice(1).toLowerCase();
  const mime=detected?.[0] || (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(declaredMime) ? declaredMime : 'application/octet-stream');
  const ext=detected?.[1] || (/^[a-z0-9]{1,10}$/.test(knownExtension) ? knownExtension : 'bin');
  const identity=crypto.createHash('sha256').update(String(filename)).digest('hex').slice(0,20);
  return {filename:`reference-${identity}.${ext}`,mime,detected:Boolean(detected)};
}

function appendReferenceFile(form, field, bytes, filename, mime) {
  const metadata=uploadMetadata(bytes,filename,mime);
  form.append(field,new Blob([bytes],{type:metadata.mime}),metadata.filename);
  return metadata;
}
module.exports={uploadMetadata,appendReferenceFile,sniffMedia};
