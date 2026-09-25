const crypto = require('node:crypto');
const path = require('node:path');

// Transmission metadata only: never rename or re-encode the original media.
// Inspect a bounded prefix of bytes already read by the caller.
function sniffMedia(bytes, filename = '', declaredMime = '') {
  const b = bytes.subarray(0, 4096);
  if (b.length >= 8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png','png'];
  if (b.length >= 3 && b[0]===255 && b[1]===216 && b[2]===255) return ['image/jpeg','jpg'];
  const head=b.toString('ascii',0,12);
  if (/^GIF8[79]a/.test(head)) return ['image/gif','gif'];
  if (head.startsWith('RIFF') && head.slice(8,12)==='WEBP') return ['image/webp','webp'];
  if (head.startsWith('RIFF') && head.slice(8,12)==='WAVE') return ['audio/wav','wav'];
  if (head.startsWith('fLaC')) return ['audio/flac','flac'];
  if (head.startsWith('ID3')) return ['audio/mpeg','mp3'];
  if (head.startsWith('BM') && b.length >= 26) return ['image/bmp','bmp'];
  if (b.subarray(0,4).equals(Buffer.from([73,73,42,0])) || b.subarray(0,4).equals(Buffer.from([77,77,0,42]))) return ['image/tiff','tiff'];
  if (head.startsWith('RIFF') && head.slice(8,12)==='AVI ') return ['video/x-msvideo','avi'];
  if (head.startsWith('OggS')) {
    // Codec identity wins. The extension is only a hint inside a known
    // container, never evidence that arbitrary .png/.mp4 bytes are media.
    const sample=b.toString('latin1');
    if (sample.includes('theora')) return ['video/ogg','ogv'];
    if (sample.includes('OpusHead') || sample.includes('vorbis') || sample.includes('Speex   ') || sample.includes('FLAC')) return ['audio/ogg','ogg'];
    const video=/\.ogv$/i.test(filename) || /^video\//i.test(declaredMime);
    return [video?'video/ogg':'audio/ogg',video?'ogv':'ogg'];
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
    const sample=b.toString('latin1');
    if (sample.includes('webm')) {
      const audio=/\.(weba|opus)$/i.test(filename) || /^audio\//i.test(declaredMime);
      return [audio?'audio/webm':'video/webm',audio?'weba':'webm'];
    }
    if (sample.includes('matroska')) return ['video/x-matroska','mkv'];
  }
  // MPEG audio without an ID3 tag: require a valid version/layer/bitrate/rate.
  if (b.length >= 4 && b[0]===255 && (b[1]&0xe0)===0xe0 && (b[1]&0x18)!==8
      && (b[1]&6)!==0 && (b[2]>>4)!==0 && (b[2]>>4)!==15 && (b[2]&12)!==12) return ['audio/mpeg','mp3'];
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
  const normalizedMime=String(declaredMime || '').split(';')[0].trim().toLowerCase();
  const detected=sniffMedia(bytes,filename,normalizedMime);
  const knownExtension=path.extname(String(filename)).slice(1).toLowerCase();
  const mime=detected?.[0] || (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(normalizedMime) ? normalizedMime : 'application/octet-stream');
  const ext=detected?.[1] || (/^[a-z0-9]{1,10}$/.test(knownExtension) ? knownExtension : 'bin');
  const identity=crypto.createHash('sha256').update(String(filename)).digest('hex').slice(0,20);
  return {filename:`reference-${identity}.${ext}`,mime,extension:ext,detected:Boolean(detected)};
}

function appendReferenceFile(form, field, bytes, filename, mime) {
  const metadata=uploadMetadata(bytes,filename,mime);
  form.append(field,new Blob([bytes],{type:metadata.mime}),metadata.filename);
  return metadata;
}
module.exports={uploadMetadata,appendReferenceFile,sniffMedia};
