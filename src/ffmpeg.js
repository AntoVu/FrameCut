// Pure helpers that turn the editor state into FFmpeg arguments.
// Kept free of Electron so it can be tested on its own.

const extname = (p) => { const m = /\.[^.\\/]+$/.exec(p); return m ? m[0] : ''; };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Hardware encoders we try, in order of preference.
const ENCODERS = {
  h264: [
    { id: 'h264_nvenc', label: 'NVIDIA NVENC', hw: true },
    { id: 'h264_qsv', label: 'Intel Quick Sync', hw: true },
    { id: 'h264_amf', label: 'AMD AMF', hw: true },
    { id: 'libx264', label: 'CPU (x264)', hw: false },
  ],
  hevc: [
    { id: 'hevc_nvenc', label: 'NVIDIA NVENC', hw: true },
    { id: 'hevc_qsv', label: 'Intel Quick Sync', hw: true },
    { id: 'hevc_amf', label: 'AMD AMF', hw: true },
    { id: 'libx265', label: 'CPU (x265)', hw: false },
  ],
};

// quality: 'high' | 'balanced' | 'small'
function qualityArgs(encoder, quality) {
  const q = { high: 0, balanced: 1, small: 2 }[quality] ?? 1;
  if (encoder.endsWith('_nvenc')) {
    const cq = [19, 23, 28][q];
    return ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-pix_fmt', 'yuv420p'];
  }
  if (encoder.endsWith('_qsv')) {
    const gq = [20, 24, 29][q];
    return ['-preset', 'faster', '-global_quality', String(gq), '-pix_fmt', 'nv12'];
  }
  if (encoder.endsWith('_amf')) {
    const qp = [20, 24, 29][q];
    return ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(qp), '-qp_p', String(qp), '-qp_b', String(qp), '-pix_fmt', 'nv12'];
  }
  if (encoder === 'libx265') {
    return ['-preset', 'fast', '-crf', String([20, 24, 29][q]), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'];
  }
  // libx264
  return ['-preset', 'veryfast', '-crf', String([18, 22, 27][q]), '-pix_fmt', 'yuv420p'];
}

// Source frame size as FFmpeg sees it after auto-rotation.
function orientedSize(info) {
  const rot = Math.abs(info.rotation || 0) % 180;
  return rot === 90 ? { w: info.height, h: info.width } : { w: info.width, h: info.height };
}

// Turn the normalized crop (0..1) into even pixel values inside the frame.
function cropPixels(info, crop) {
  const { w: W, h: H } = orientedSize(info);
  let cw = even(clamp(crop.w, 0, 1) * W);
  let ch = even(clamp(crop.h, 0, 1) * H);
  cw = Math.min(cw, W - (W % 2));
  ch = Math.min(ch, H - (H % 2));
  let cx = even(clamp(crop.x, 0, 1) * W);
  let cy = even(clamp(crop.y, 0, 1) * H);
  cx = clamp(cx, 0, W - cw);
  cy = clamp(cy, 0, H - ch);
  return { x: cx, y: cy, w: cw, h: ch, full: cw >= W - 1 && ch >= H - 1 && cx === 0 && cy === 0, W, H };
}

// Work out the final output size and the filter chain.
// edit = { crop:{x,y,w,h}, rotate:0|90|180|270, flipH, flipV,
//          size:{ mode:'crop'|'source'|'height'|'custom', height, width, customW, customH },
//          fit:'stretch'|'fit'|'fill' }
function buildVideoFilters(info, edit) {
  const c = cropPixels(info, edit.crop);
  const sar = info.sar || 1;
  const filters = [];
  if (!c.full) filters.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);

  const rot = ((edit.rotate || 0) % 360 + 360) % 360;
  if (rot === 90) filters.push('transpose=1');
  else if (rot === 180) filters.push('hflip,vflip');
  else if (rot === 270) filters.push('transpose=2');
  if (edit.flipH) filters.push('hflip');
  if (edit.flipV) filters.push('vflip');

  // Size of the picture after crop + rotation (in display pixels).
  let pw = Math.round(c.w * sar);
  let ph = c.h;
  if (rot === 90 || rot === 270) [pw, ph] = [ph, pw];

  const s = edit.size || { mode: 'crop' };
  let ow = pw;
  let oh = ph;
  if (s.mode === 'source') {
    // "Zoom": blow the cropped area back up to the original frame size.
    const src = orientedSize(info);
    let sw = Math.round(src.w * sar);
    let sh = src.h;
    if (rot === 90 || rot === 270) [sw, sh] = [sh, sw];
    ow = sw;
    oh = sh;
  } else if (s.mode === 'height') {
    oh = s.height;
    ow = (pw / ph) * oh;
  } else if (s.mode === 'width') {
    ow = s.width;
    oh = (ph / pw) * ow;
  } else if (s.mode === 'custom') {
    ow = s.customW || pw;
    oh = s.customH || ph;
  }
  ow = even(ow);
  oh = even(oh);

  const sameSize = ow === even(pw) && oh === even(ph);
  const fit = edit.fit || 'stretch';
  if (!sameSize || sar !== 1) {
    const sameAspect = Math.abs(ow / oh - pw / ph) < 0.01;
    if (fit === 'stretch' || sameAspect) {
      filters.push(`scale=${ow}:${oh}:flags=lanczos`);
    } else if (fit === 'fit') {
      filters.push(`scale=${ow}:${oh}:force_original_aspect_ratio=decrease:flags=lanczos`);
      filters.push(`pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2:color=black`);
    } else {
      filters.push(`scale=${ow}:${oh}:force_original_aspect_ratio=increase:flags=lanczos`);
      filters.push(`crop=${ow}:${oh}`);
    }
  } else if (!c.full || rot) {
    // Even-sized crop already; nothing to scale.
  }
  if (filters.length) filters.push('setsar=1');
  return { filters, outW: ow, outH: oh, crop: c };
}

function needsReencode(info, edit) {
  return buildVideoFilters(info, edit).filters.length > 0;
}

const MP4_AUDIO_OK = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac', 'flac']);

function audioArgs(info, ext) {
  if (!info.audioCodec) return [];
  const container = ext.replace('.', '').toLowerCase();
  if (container === 'mkv') return ['-c:a', 'copy'];
  if ((container === 'mp4' || container === 'mov' || container === 'm4v') && MP4_AUDIO_OK.has(info.audioCodec)) {
    return ['-c:a', 'copy'];
  }
  return ['-c:a', 'aac', '-b:a', '192k'];
}

// Args for one segment. job = { input, output, start, end, info, edit, encoder, quality }
function segmentArgs(job) {
  const { input, output, start, end, info, edit } = job;
  const ext = extname(output);
  const dur = Math.max(0.01, end - start);
  const reencode = job.force || needsReencode(info, edit);
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];

  if (!reencode) {
    args.push('-ss', start.toFixed(3), '-i', input, '-t', dur.toFixed(3));
    args.push('-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    const hw = !/^lib/.test(job.encoder);
    if (hw) args.push('-hwaccel', 'auto');
    args.push('-ss', start.toFixed(3), '-i', input, '-t', dur.toFixed(3));
    args.push('-map', '0:v:0', '-map', '0:a?');
    const { filters } = buildVideoFilters(info, edit);
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-c:v', job.encoder, ...qualityArgs(job.encoder, job.quality));
    args.push(...audioArgs(info, ext));
  }
  if (/\.(mp4|mov|m4v)$/i.test(ext)) args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

// Several segments re-encoded and joined in a single pass (frame-accurate).
// job = { input, output, segments:[{start,end}], info, edit, encoder, quality }
function mergeEncodeArgs(job) {
  const { input, output, segments, info, edit } = job;
  const ext = extname(output);
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  const hw = !/^lib/.test(job.encoder);
  for (const s of segments) {
    if (hw) args.push('-hwaccel', 'auto');
    args.push('-ss', s.start.toFixed(3), '-t', Math.max(0.01, s.end - s.start).toFixed(3), '-i', input);
  }
  const { filters } = buildVideoFilters(info, edit);
  const chain = filters.length ? filters.join(',') : 'null';
  const hasAudio = !!info.audioCodec;
  const parts = [];
  let inputs = '';
  segments.forEach((_, i) => {
    parts.push(`[${i}:v:0]${chain},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) parts.push(`[${i}:a:0]aresample=async=1,asetpts=PTS-STARTPTS[a${i}]`);
    inputs += hasAudio ? `[v${i}][a${i}]` : `[v${i}]`;
  });
  parts.push(`${inputs}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}${hasAudio ? '[v][a]' : '[v]'}`);
  args.push('-filter_complex', parts.join(';'), '-map', '[v]');
  if (hasAudio) args.push('-map', '[a]');
  args.push('-c:v', job.encoder, ...qualityArgs(job.encoder, job.quality));
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  if (/\.(mp4|mov|m4v)$/i.test(ext)) args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

// ---------------- Smart cut (frame-exact trimming without full re-encode) ----------------
// Only the frames between a cut point and the nearest keyframe are re-encoded, in the
// source's own codec; everything between keyframes is stream-copied untouched.

const SMART_CODECS = new Set(['h264', 'hevc']);
const canSmartCut = (info) => SMART_CODECS.has(info.videoCodec);

// Which encoder ids can produce the source's codec, best first.
function smartEncoderIds(info, detected) {
  const list = (detected && detected[info.videoCodec]) || ENCODERS[info.videoCodec] || [];
  const ids = list.map((e) => e.id);
  const cpu = info.videoCodec === 'hevc' ? 'libx265' : 'libx264';
  if (!ids.includes(cpu)) ids.push(cpu);
  return ids;
}

const is10bit = (pf) => /10|12/.test(pf || '');

function smartQualityArgs(encoder, info) {
  const ten = is10bit(info.pixFmt);
  const args = [];
  if (encoder === 'libx264') {
    args.push('-preset', 'veryfast', '-crf', '15', '-pix_fmt', info.pixFmt && /^yuv4(20|22|44)p(10le)?$/.test(info.pixFmt) ? info.pixFmt : 'yuv420p');
  } else if (encoder === 'libx265') {
    args.push('-preset', 'superfast', '-crf', '17', '-pix_fmt', ten ? 'yuv420p10le' : 'yuv420p', '-x265-params', 'log-level=error');
  } else if (encoder.endsWith('_nvenc')) {
    args.push('-preset', 'p4', '-rc', 'vbr', '-cq', '17', '-b:v', '0', '-pix_fmt', ten ? 'p010le' : 'yuv420p');
    if (ten && encoder.startsWith('hevc')) args.push('-profile:v', 'main10');
  } else if (encoder.endsWith('_qsv')) {
    args.push('-preset', 'faster', '-global_quality', '18', '-pix_fmt', ten ? 'p010le' : 'nv12');
    if (ten && encoder.startsWith('hevc')) args.push('-profile:v', 'main10');
  } else if (encoder.endsWith('_amf')) {
    args.push('-rc', 'cqp', '-qp_i', '18', '-qp_p', '18', '-qp_b', '18', '-pix_fmt', ten ? 'p010le' : 'nv12');
    if (ten && encoder.startsWith('hevc')) args.push('-profile:v', 'main10');
  }
  // Keep colour tags identical to the copied frames (matters for HDR phone videos).
  if (info.colorPrimaries) args.push('-color_primaries', info.colorPrimaries);
  if (info.colorTrc) args.push('-color_trc', info.colorTrc);
  if (info.colorSpace) args.push('-colorspace', info.colorSpace);
  if (info.colorRange) args.push('-color_range', info.colorRange);
  return args;
}

// Re-encode frames with time in [from, to) (to = null → until the end) to MPEG-TS.
function smartEncodeArgs({ input, output, from, to, info, encoder }) {
  const fd = 1 / (info.fps || 30);
  const ss = Math.max(0, from - fd / 4);
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-noautorotate', '-ss', ss.toFixed(6), '-i', input];
  if (to != null) args.push('-t', (to - from).toFixed(6));
  args.push('-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough');
  args.push('-c:v', encoder, ...smartQualityArgs(encoder, info), '-f', 'mpegts', output);
  return args;
}

// Stream-copy a time range with keyframe-exact splits (works the same on every FFmpeg version):
// seek a little early, then let the segment muxer split at the exact cut timestamps.
// `landing` = timestamp of the first packet FFmpeg will output for this seek (see landingArgs).
// Returns { args, pick } where pick is the index of the segment file holding [from, to).
function copyRangeArgs({ input, output, seek, landing, from, to, margin, kind, format }) {
  const times = [];
  let pick = 0;
  if (landing < from - margin) { times.push(from - landing - margin); pick = 1; }
  if (to != null) times.push(to - landing - margin);
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-copyts', '-ss', seek.toFixed(6)];
  if (to != null) args.push('-t', (to - seek + 3).toFixed(3));
  args.push('-i', input);
  if (kind === 'v') args.push('-map', '0:v:0', '-c:v', 'copy', '-an', '-sn', '-dn');
  else args.push('-map', '0:a', '-c:a', 'copy', '-vn', '-sn', '-dn');
  args.push('-f', 'segment', '-segment_format', format, '-reset_timestamps', '1');
  if (times.length) args.push('-segment_times', times.map((t) => t.toFixed(6)).join(','));
  args.push(output);
  return { args, pick };
}

// Prints the first packet FFmpeg outputs for a copy-mode seek (framecrc format).
function landingArgs({ input, seek, kind }) {
  return ['-v', 'error', '-copyts', '-ss', seek.toFixed(6), '-i', input, '-map', kind === 'v' ? '0:v:0' : '0:a:0',
    '-c', 'copy', `-frames:${kind}`, '1', '-f', 'framecrc', '-'];
}
function parseLanding(text, startTime) {
  const tb = /#tb \d+: (\d+)\/(\d+)/.exec(text);
  const line = text.split(/\r?\n/).find((l) => /^\d+,/.test(l));
  if (!tb || !line) return null;
  const pts = Number(line.split(',')[2]);
  return (pts * Number(tb[1])) / Number(tb[2]) - (startTime || 0);
}

// Work out the pieces for one segment from probed video packets.
// packets: [{t, key}] with t in "seek time" (seconds from file start), sorted.
function smartPlan(packets, info, seg) {
  const fd = 1 / (info.fps || 30);
  const eps = 1e-4;
  const toEndReq = seg.end >= info.duration - fd / 2;
  const Sf = (packets.find((p) => p.t >= seg.start - fd / 2) || {}).t;
  if (Sf == null) return null;
  let Ef = null;
  if (!toEndReq) {
    const e = packets.find((p) => p.t >= seg.end - fd / 2);
    Ef = e ? e.t : null;
  }
  const toEnd = Ef == null;
  const keys = packets.filter((p) => p.key).map((p) => p.t);
  const K1 = keys.find((k) => k >= Sf - eps);
  let K2 = null;
  if (!toEnd) for (const k of keys) if (k <= Ef + eps) K2 = k;

  const parts = [];
  const whole = K1 == null || (!toEnd && (K1 >= Ef - eps || K2 == null || K2 <= K1 + eps));
  if (whole) {
    parts.push({ kind: 'enc', from: Sf, to: Ef });
  } else {
    if (K1 > Sf + eps) parts.push({ kind: 'enc', from: Sf, to: K1 });
    if (toEnd) parts.push({ kind: 'copy', from: K1, to: null });
    else {
      parts.push({ kind: 'copy', from: K1, to: K2 });
      if (Ef > K2 + eps) parts.push({ kind: 'enc', from: K2, to: Ef });
    }
  }
  return { start: Sf, end: Ef, parts };
}

// Parse `ffprobe -show_entries packet=pts_time,flags -of csv=p=0` output (decode order).
// A keyframe is a safe cut point only if no later packet (in decode order) shows before it;
// open-GOP keyframes (common in x265 encodes) have such "leading" frames and are skipped.
function parsePackets(csv, startTime) {
  const raw = [];
  for (const line of csv.split(/\r?\n/)) {
    const [pts, flags] = line.split(',');
    const v = Number(pts);
    if (!pts || !isFinite(v)) continue;
    raw.push({ t: Math.round((v - (startTime || 0)) * 1e6) / 1e6, key: (flags || '').includes('K') });
  }
  raw.forEach((p, i) => {
    if (!p.key) return;
    const next = raw.slice(i + 1, i + 17);
    p.clean = next.length >= Math.min(16, raw.length - i - 1) && next.length > 0 && !next.some((q) => q.t < p.t - 1e-6);
    if (i === raw.length - 1) p.clean = false;
  });
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    if (seen.has(p.t)) continue;
    seen.add(p.t);
    out.push({ t: p.t, key: p.key && p.clean });
  }
  return out.sort((a, b) => a.t - b.t);
}

const concatLine = (file, duration, outpoint) => {
  let s = `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  if (outpoint != null) s += `\noutpoint ${outpoint.toFixed(6)}`;
  if (duration != null) s += `\nduration ${duration.toFixed(6)}`;
  return s;
};

// Final step: join video pieces (+ audio) into the output container. All stream copy.
function smartMuxArgs({ videoList, audio, audioIsList, input, output, info }) {
  const ext = extname(output);
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  if (info.rotation) args.push('-display_rotation', String(info.rotation));
  args.push('-f', 'concat', '-safe', '0', '-i', videoList);
  let n = 1;
  let ai = -1;
  if (audio) {
    args.push('-f', 'concat', '-safe', '0', '-i', audio);
    ai = n++;
  }
  args.push('-i', input);
  const meta = n;
  args.push('-map', '0:v:0');
  if (ai >= 0) args.push('-map', `${ai}:a?`);
  args.push('-map_metadata', String(meta), '-c:v', 'copy');
  if (ai >= 0) args.push(...audioArgs(info, ext));
  // hev1 keeps the per-keyframe parameter sets the joined pieces need (hvc1 strips them).
  if (info.videoCodec === 'hevc' && /\.(mp4|mov|m4v)$/i.test(ext)) args.push('-tag:v', 'hev1');
  if (/\.(mp4|mov|m4v)$/i.test(ext)) args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

function concatArgs(listFile, output) {
  const args = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-map', '0', '-c', 'copy'];
  if (/\.(mp4|mov|m4v)$/i.test(output)) args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

function parseProbe(json) {
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('No video stream found in this file.');
  let rotation = 0;
  for (const sd of v.side_data_list || []) if (typeof sd.rotation === 'number') rotation = sd.rotation;
  if (!rotation && v.tags && v.tags.rotate) rotation = Number(v.tags.rotate) || 0;
  const rate = (r) => {
    if (!r) return 0;
    const [n, d] = r.split('/').map(Number);
    return d ? n / d : n;
  };
  let sar = 1;
  if (v.sample_aspect_ratio && v.sample_aspect_ratio !== '0:1' && v.sample_aspect_ratio !== '1:1') {
    const [n, d] = v.sample_aspect_ratio.split(':').map(Number);
    if (n && d) sar = n / d;
  }
  const duration = Number((json.format && json.format.duration) || v.duration || 0);
  return {
    width: v.width,
    height: v.height,
    rotation,
    sar,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30,
    duration,
    videoCodec: v.codec_name,
    pixFmt: v.pix_fmt || '',
    colorPrimaries: v.color_primaries && v.color_primaries !== 'unknown' ? v.color_primaries : '',
    colorTrc: v.color_transfer && v.color_transfer !== 'unknown' ? v.color_transfer : '',
    colorSpace: v.color_space && v.color_space !== 'unknown' ? v.color_space : '',
    colorRange: v.color_range && v.color_range !== 'unknown' ? v.color_range : '',
    startTime: Number((json.format && json.format.start_time) || 0) || 0,
    audioCodec: a ? a.codec_name : null,
    container: (json.format && json.format.format_name) || '',
    size: Number((json.format && json.format.size) || 0),
    bitRate: Number((json.format && json.format.bit_rate) || 0),
  };
}

const FF = {
  ENCODERS,
  qualityArgs,
  orientedSize,
  cropPixels,
  buildVideoFilters,
  needsReencode,
  segmentArgs,
  mergeEncodeArgs,
  canSmartCut,
  smartEncoderIds,
  smartEncodeArgs,
  copyRangeArgs,
  landingArgs,
  parseLanding,
  smartPlan,
  parsePackets,
  smartMuxArgs,
  concatLine,
  concatArgs,
  parseProbe,
};
if (typeof module !== 'undefined' && module.exports) module.exports = FF;
else window.FF = FF;
