const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// FFmpeg's file-backed option syntax keeps complex edits below the Windows
// process command-line limit. Retain the graph with the job for diagnostics.
function filterGraphArgs(outputPath, filters) {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const graphPath = path.join(directory, `.media-filter-${randomUUID()}.txt`);
  fs.writeFileSync(graphPath, filters.join(';'), { encoding: 'utf8', flag: 'wx' });
  return ['-/filter_complex', graphPath];
}

module.exports = { filterGraphArgs };
