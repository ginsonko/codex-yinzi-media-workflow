'use strict';

// Some official search endpoints frame JSON messages inside the response body.
function decodeBodies(input) {
  const buffer=Buffer.isBuffer(input)?input:Buffer.from(input);
  if(buffer.length>12*1024*1024)return [];
  const text=buffer.toString('utf8').trim();
  try{return [JSON.parse(text)];}catch{}
  const results=[];
  let offset=0;
  while(offset<buffer.length && results.length<500) {
    const end=buffer.indexOf('\r\n',offset);if(end<0)break;
    const header=buffer.subarray(offset,end).toString('ascii');
    if(!/^[\da-f]+(?:;[^\r\n]*)?$/i.test(header))break;
    const length=parseInt(header,16);if(!length)break;
    const start=end+2, next=start+length;
    if(next+2>buffer.length || buffer.subarray(next,next+2).toString()!=='\r\n')break;
    try{results.push(JSON.parse(buffer.subarray(start,next).toString('utf8')));}catch{}
    offset=next+2;
  }
  if(results.length)return results;
  for(const block of text.split(/\r?\n\r?\n/)) {
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(data && data!=='[DONE]'){try{results.push(JSON.parse(data));}catch{}}
    if(results.length>=500)break;
  }
  return results;
}
module.exports={decodeBodies};
