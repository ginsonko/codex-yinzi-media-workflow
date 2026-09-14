'use strict';

/**
 * Component manifest definition for tool.yt-dlp.
 * Compatible with backend-node/src/services/componentRuntime.js registry structure.
 */
const YT_DLP_COMPONENT_DEFINITION = {
  component_id: 'tool.yt-dlp',
  version: '2026.08.19',
  kind: 'zip',
  platforms: ['win32-x64'],
  license: 'Unlicense',
  source: 'https://github.com/yt-dlp/yt-dlp',
  urls: [
    'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_win.zip'
  ],
  sha256: '30b4c14aafab6082becff7881e41b76df46dc43ea7633479410a91e29da492bf',
  disk_bytes: 120 * 1024 * 1024,
  executables: {
    'yt-dlp': 'yt-dlp.exe'
  },
  probe_args: ['--version'],
  probe_exit_codes: [0],
  probe_output: '2026.08.19',
  verify_all_files: false
};

module.exports = {
  YT_DLP_COMPONENT_DEFINITION
};