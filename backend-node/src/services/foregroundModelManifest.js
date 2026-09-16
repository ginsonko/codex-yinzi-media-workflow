'use strict';

const U2NETP_REVISION = '7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8';
const U2NET_REVISION = 'c08042b462485d8597c89d3ce831d00be8582c5c';
const REMBG_RELEASE = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0';

function urls(hfRepo, revision, file, githubName) {
  return [
    `https://hf-mirror.com/${hfRepo}/resolve/${revision}/${file}`,
    `https://huggingface.co/${hfRepo}/resolve/${revision}/${file}`,
    `${REMBG_RELEASE}/${githubName}`,
  ];
}

const MODELS = {
  u2netp: {
    id: 'u2netp',
    filename: 'u2netp.onnx',
    path: 'models/u2netp.onnx',
    name: 'U2NetP lightweight saliency (320²)',
    md5: '8e83ca70e441ab06c318d82300c84806',
    sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
    bytes: 4574861,
    role: 'default',
    hf: { repo: 'BritishWerewolf/U-2-Netp', revision: U2NETP_REVISION, file: 'onnx/model.onnx' },
  },
  u2net: {
    id: 'u2net',
    filename: 'u2net.onnx',
    path: 'models/u2net.onnx',
    name: 'U2Net full saliency (320²)',
    md5: '60024c5c889badc19c04ad937298a77b',
    sha256: '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491',
    bytes: 175997641,
    role: 'full',
    hf: { repo: 'BritishWerewolf/U-2-Net', revision: U2NET_REVISION, file: 'onnx/model.onnx' },
  },
};

const FOREGROUND_INFERENCE_SIZE = 320;
const FOREGROUND_MEAN = [0.485, 0.456, 0.406];
const FOREGROUND_STD = [0.229, 0.224, 0.225];

const FOREGROUND_COMPONENT_DEFINITION = {
  component_id: 'vision.foreground-seg',
  version: 'u2net-rembg-v0.0.0',
  template: 'foreground-seg',
  platforms: ['win32-x64'],
  disk_bytes: 400 * 1024 * 1024,
  license: 'U-2-Net Apache-2.0; rembg MIT ONNX export (v0.0.0); BritishWerewolf Hub copy Apache-2.0; onnxruntime MIT',
  source: 'https://github.com/xuebinqin/U-2-Net ; https://github.com/danielgatis/rembg/releases/tag/v0.0.0 ; https://huggingface.co/BritishWerewolf/U-2-Netp/tree/7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8',
  artifacts: [
    {
      name: MODELS.u2netp.name,
      path: MODELS.u2netp.path,
      urls: urls(MODELS.u2netp.hf.repo, MODELS.u2netp.hf.revision, MODELS.u2netp.hf.file, MODELS.u2netp.filename),
      sha256: MODELS.u2netp.sha256,
    },
    {
      name: MODELS.u2net.name,
      path: MODELS.u2net.path,
      urls: urls(MODELS.u2net.hf.repo, MODELS.u2net.hf.revision, MODELS.u2net.hf.file, MODELS.u2net.filename),
      sha256: MODELS.u2net.sha256,
    },
    {
      name: 'U2NetP input/output contract',
      path: 'models/u2netp-config.json',
      urls: [
        `https://hf-mirror.com/BritishWerewolf/U-2-Netp/resolve/${U2NETP_REVISION}/config.json`,
        `https://huggingface.co/BritishWerewolf/U-2-Netp/resolve/${U2NETP_REVISION}/config.json`,
      ],
      sha256: '863f4c818e573a77b0bedea8ecacc6c449ec24e8c179e2f8b1f4067ba8d0dea6',
    },
    {
      name: 'U2Net full input/output contract',
      path: 'models/u2net-config.json',
      urls: [
        `https://hf-mirror.com/BritishWerewolf/U-2-Net/resolve/${U2NET_REVISION}/config.json`,
        `https://huggingface.co/BritishWerewolf/U-2-Net/resolve/${U2NET_REVISION}/config.json`,
      ],
      sha256: 'de6cbb33feba0d387c4ef791de387925bcb8b50c3ad912190cb8e186db0cfea1',
    },
  ],
};

module.exports = {
  FOREGROUND_INFERENCE_SIZE,
  FOREGROUND_MEAN,
  FOREGROUND_STD,
  MODELS,
  FOREGROUND_COMPONENT_DEFINITION,
  U2NETP_REVISION,
  U2NET_REVISION,
};
