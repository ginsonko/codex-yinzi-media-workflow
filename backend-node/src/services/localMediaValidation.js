const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const files=['localMediaOperations.js','localMediaParameterSchemas.json','localMediaExecutor.js','localMediaSources.js','localMediaWorker.js','componentRuntime.js','videoReversePrompt.js','videoTimelineEdit.js','audioBeatAnalysis.js','imageCompositeLayers.js','videoComposeClips.js','videoTransitions.js','videoCompositeLayers.js','videoCameraMotion.js','keyframeTracks.js','videoLayerAnimation.js','mediaStreamTiming.js','mediaFilterGraph.js','localOcrOperation.js','localUpscaleOperation.js','localSearchablePdfOperation.js'];
files.push('ade20kLabels.js','skyReplaceCore.js','skyReplaceImage.js','skyReplaceVideo.js','skyVideoStream.js','skyModelManifest.js','skyMaskRefinement.js');
files.push('sourceLibraryOperations.js','mediaDownload.js','mediaIndex.js','mediaDownloadManifest.js');
files.push('videoFrameSequence.js');
files.push('mediaExtensionCandidates.js');
files.push('mediaExtensionSchemas.json');
function sourceFingerprints(){return Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,file),'utf8').replace(/\r\n/g,'\n')).digest('hex') ]));}
let cached;
function verifiedOperation(id){
 if(cached===undefined){try{const receipt=JSON.parse(fs.readFileSync(path.join(__dirname,'../../components/acceptance-windows-x64.json'),'utf8'));const fingerprints=sourceFingerprints();cached=receipt.status==='passed'&&Object.entries(fingerprints).every(([file,digest])=>receipt.source_fingerprints?.[file]===digest)?new Set(receipt.operations.filter(item=>item.status==='passed'&&item.output_sha256&&item.bytes>0).map(item=>item.id)):new Set();}catch{cached=new Set();}}
 return cached.has(id);
}
module.exports={sourceFingerprints,verifiedOperation};
