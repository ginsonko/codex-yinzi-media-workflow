const revision = 'd3e5499fa8701ff0453ca940a8dfeae39b2f1504';
const repository = 'Xenova/segformer-b0-finetuned-ade-512-512';
const urls = file => [
  `https://hf-mirror.com/${repository}/resolve/${revision}/${file}`,
  `https://huggingface.co/${repository}/resolve/${revision}/${file}`,
];
const SKY_COMPONENT_DEFINITION = {
  component_id:'vision.sky-seg', version:'segformer-b0-onnx-'+revision.slice(0,12),
  template:'sky-seg', platforms:['win32-x64'], disk_bytes:210000000,
  license:'onnxruntime MIT; NVIDIA SegFormer model terms from upstream model card',
  source:'https://huggingface.co/'+repository+'/tree/'+revision,
  artifacts:[
    {name:'SegFormer B0 FP32 model',path:'models/model.onnx',urls:urls('onnx/model.onnx'),
      sha256:'3e5c18a4be395f16646438d54c42377ddc202edfa33d5eced0c9506de75c44c2'},
    {name:'ADE20K model configuration',path:'models/config.json',urls:urls('config.json'),
      sha256:'435799652b2b64c3e422dea20fed4c59651dae9f0e291fd885e9e067fee0ce2a'},
  ],
};
module.exports={SKY_COMPONENT_DEFINITION};