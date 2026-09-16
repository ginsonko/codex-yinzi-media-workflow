'use strict';

/**
 * Component manifest definition for vision.rife.
 * Official RIFE ncnn Vulkan binary distribution by nihui.
 * Compatible with backend-node/src/services/componentRuntime.js registry structure.
 */
const RIFE_COMPONENT_DEFINITION = {
  component_id: 'vision.rife',
  version: '20221029',
  kind: 'zip',
  platforms: ['win32-x64'],
  license: 'MIT; ncnn BSD-3-Clause; RIFE Megvii research',
  source: 'https://github.com/nihui/rife-ncnn-vulkan',
  urls: [
    'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip'
  ],
  sha256: 'd8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606',
  disk_bytes: 1024 * 1024 * 1024,
  executables: {
    'rife': 'rife-ncnn-vulkan-20221029-windows/rife-ncnn-vulkan.exe'
  },
  probe_args: ['-h'],
  probe_exit_codes: [4294967295, -1, 127],
  probe_output: 'Usage: rife-ncnn-vulkan',
  verify_all_files: true,
  available_models: [
    'rife', 'rife-anime', 'rife-HD', 'rife-UHD',
    'rife-v2', 'rife-v2.3', 'rife-v2.4', 'rife-v3.0',
    'rife-v3.1', 'rife-v4', 'rife-v4.6'
  ],
  default_model: 'rife-v4.6'
};

module.exports = {
  RIFE_COMPONENT_DEFINITION
};
