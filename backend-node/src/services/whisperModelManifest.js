'use strict';

/**
 * 银子万能媒体工作流 - media.whisper 组件清单定义
 * 用于接入 backend-node/src/services/componentRuntime.js 的 registry()
 *
 * 包含官方 Release 预编译 Windows x64 CPU 二进制与多语言 ggml 预训练模型
 */

const WHISPER_COMPONENT_DEFINITION = {
  component_id: 'media.whisper',
  version: '1.9.4-b5130',
  kind: 'zip',
  platforms: ['win32-x64'],
  license: 'MIT',
  source: 'https://github.com/ggml-org/whisper.cpp',
  urls: [
    'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
    'https://api.github.com/repos/ggml-org/whisper.cpp/releases/assets/556561306'
  ],
  sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
  disk_bytes: 400 * 1024 * 1024,
  verify_all_files: true,
  executables: {
    'whisper-cli': 'Release/whisper-cli.exe'
  },
  probe_args: ['-h'],
  probe_exit_codes: [0],
  probe_output: 'usage:',
  artifacts: [
    {
      name: 'ggml-base.bin (多语言标准模型，默认推荐)',
      path: 'models/ggml-base.bin',
      urls: [
        'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
        'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
      ],
      sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
      size_bytes: 147951465
    },
    {
      name: 'ggml-tiny.bin (轻量多语言模型，低内存备选)',
      path: 'models/ggml-tiny.bin',
      urls: [
        'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
        'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
      ],
      sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
      size_bytes: 77691713
    }
  ]
};

module.exports = {
  WHISPER_COMPONENT_DEFINITION
};