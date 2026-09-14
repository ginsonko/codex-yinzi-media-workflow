const revision = 'f12e12798e8314f7c074a6656816c048dcc95b7a';
module.exports = {
  FACE_INFERENCE_SIZE: 640,
  FACE_COMPONENT_DEFINITION: {
    component_id: 'vision.face-detector', version: 'yunet-2023mar-'+revision.slice(0,12),
    template: 'face-detector', platforms: ['win32-x64'], disk_bytes: 210000000,
    license: 'YuNet MIT; ONNX Runtime MIT',
    source: `https://github.com/opencv/opencv_zoo/tree/${revision}/models/face_detection_yunet`,
    artifacts: [{
      name: 'YuNet 2023mar CPU model', path: 'models/yunet.onnx',
      urls: [
        `https://media.githubusercontent.com/media/opencv/opencv_zoo/${revision}/models/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
        `https://github.com/opencv/opencv_zoo/raw/${revision}/models/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
      ],
      sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    }],
  },
};