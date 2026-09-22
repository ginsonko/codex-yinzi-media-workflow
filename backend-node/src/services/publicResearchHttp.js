'use strict';
const https = require('node:https');
const zlib = require('node:zlib');
const {validateUrl} = require('./mediaDownload');
const fail = (code,message) => Object.assign(new Error(message),{code});
function readPublicPage(url, {hosts, timeout = 15000, maxBytes = 4 * 1024 * 1024} = {}) {
  validateUrl(url);
  const u = new URL(url);
  if (u.protocol !== 'https:' || !hosts?.includes(u.hostname) || u.port) throw fail('UNSUPPORTED_RESEARCH_URL','页面地址不属于当前采集适配器');
  return new Promise((resolve,reject) => {
    let settled = false, timer;
    const finish = (error,value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const req = https.get(u,{headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html','Accept-Encoding':'gzip, deflate, br'}},res => {
      if (res.statusCode !== 200) { res.resume(); finish(fail('PLATFORM_HTTP_' + res.statusCode,'公开页面 HTTP ' + res.statusCode)); return; }
      const encoding = res.headers['content-encoding'];
      const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'br' ? zlib.createBrotliDecompress() : encoding === 'deflate' ? zlib.createInflate() : null;
      const body = decoder ? res.pipe(decoder) : res;
      let size = 0; const chunks = [];
      body.on('data',chunk => { size += chunk.length; if (size > maxBytes) { finish(fail('PLATFORM_RESPONSE_TOO_LARGE','公开页面超过读取上限')); body.destroy(); req.destroy(); } else chunks.push(chunk); });
      body.on('end',() => finish(null,Buffer.concat(chunks).toString('utf8')));
      body.on('error',error=>finish(error));
      res.on('error',error=>finish(error));
    });
    timer = setTimeout(()=>{finish(fail('PLATFORM_TIMEOUT','公开页面请求超时'));req.destroy();},timeout);
    req.on('error',error=>finish(error));
  });
}
module.exports = {readPublicPage};
