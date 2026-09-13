// Container duration may be an absolute end timestamp (notably offset MKV).
// Prefer the stream duration; otherwise inspect packet PTS without buffering them.
async function streamDuration({ stream, inputPath, ffprobe, runner }) {
  const declared = Number(stream.duration);
  if (Number.isFinite(declared) && declared > 0) return declared;
  let pending = '', first = Infinity, end = -Infinity, observed = false;
  const rateParts = String(stream.avg_frame_rate || stream.r_frame_rate || '').split('/').map(Number);
  const frameDuration = rateParts[0] > 0 && rateParts[1] > 0 ? rateParts[1] / rateParts[0] : 0;
  function line(text) {
    const fields = Object.fromEntries(text.split('|').map(item => item.split('=')));
    const pts = Number(fields.pts_time);
    if (!Number.isFinite(pts)) return;
    const duration = Number(fields.duration_time);
    first = Math.min(first, pts);
    end = Math.max(end, pts + (Number.isFinite(duration) && duration > 0 ? duration : frameDuration));
    observed = true;
  }
  function consume(text) {
    pending += text;
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const item of lines) line(item);
  }
  const result = await runner(ffprobe, ['-v','error','-select_streams',String(stream.index),
    '-show_packets','-show_entries','packet=pts_time,duration_time','-of','compact=p=0',inputPath],
    { timeout:120000, onOutput:consume });
  if (!observed && !pending) consume(result.stdout || '');
  if (pending) line(pending);
  const origin = Number.isFinite(Number(stream.start_time)) ? Number(stream.start_time) : first;
  const duration = end - origin;
  return observed && Number.isFinite(duration) && duration > 0 ? duration : NaN;
}
module.exports = { streamDuration };
