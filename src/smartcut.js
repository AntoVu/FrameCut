// Frame-exact trimming that stays fast: re-encode only the frames between each cut
// and its nearest keyframe, stream-copy everything else, then join the pieces.

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./ffmpeg');

const WINDOW = 30; // seconds of packets to inspect around each cut point

async function probePackets(ffprobe, run, input, info, seg) {
  const st = info.startTime || 0;
  const ranges = [`${(st + Math.max(0, seg.start - 2)).toFixed(3)}%${(st + seg.start + WINDOW).toFixed(3)}`];
  if (seg.end < info.duration - 0.01) {
    ranges.push(`${(st + Math.max(0, seg.end - WINDOW)).toFixed(3)}%${(st + seg.end + 2).toFixed(3)}`);
  }
  const r = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', ranges.join(','),
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input,
  ]);
  if (r.code !== 0) throw new Error('Could not read keyframes from this file.');
  return F.parsePackets(r.stdout, st);
}

async function pool(tasks, limit) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      await t();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/**
 * opts = { input, info, segments, merge, ext, outDir, base, encoders (ids, best first),
 *          ffmpeg, ffprobe, run, runFfmpeg(args, onTime), onProgress(fraction), uniquePath }
 * Returns { outputs, encodedSeconds, copiedSeconds }.
 */
async function smartCut(opts) {
  const { input, info, segments, ffmpeg, ffprobe, run, runFfmpeg, onProgress } = opts;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'framecut-sc-'));
  const hasAudio = !!info.audioCodec;
  const fd = 1 / (info.fps || 30);
  const encoders = opts.encoders.length ? opts.encoders : [info.videoCodec === 'hevc' ? 'libx265' : 'libx264'];
  let encoderIdx = 0;
  let encodedSeconds = 0;
  let copiedSeconds = 0;

  // Copy [from, to) of the video (kind 'v') or all audio tracks (kind 'a') into `file`.
  const copyRange = async (kind, from, to, file, onTime) => {
    const seek = Math.max(0, from - 1);
    const lr = await run(ffmpeg, F.landingArgs({ input, seek, kind }));
    let landing = F.parseLanding(lr.stdout || '', info.startTime);
    if (landing == null) landing = seek;
    const ext = kind === 'v' ? 'ts' : 'mka';
    const pattern = path.join(tmp, `${path.basename(file, path.extname(file))}-%03d.${ext}`);
    const { args, pick } = F.copyRangeArgs({
      input, output: pattern, seek, landing, from, to, kind,
      margin: kind === 'v' ? fd / 2 : 0.01, format: kind === 'v' ? 'mpegts' : 'matroska',
    });
    await runFfmpeg(args, onTime && ((t) => onTime(t - (from - seek))));
    const chosen = pattern.replace('%03d', String(pick).padStart(3, '0'));
    if (!fs.existsSync(chosen)) throw new Error('Smart cut could not split this file at the keyframe.');
    fs.renameSync(chosen, file);
  };

  try {
    // 1. Plan every segment (cheap: reads only packet headers near the cuts).
    const plans = [];
    for (const seg of segments) {
      const packets = await probePackets(ffprobe, run, input, info, seg);
      const plan = F.smartPlan(packets, info, seg);
      if (!plan) throw new Error('Could not find frames for this cut.');
      plans.push(plan);
    }

    // 2. Build the jobs.
    const jobs = [];
    plans.forEach((plan, si) => {
      plan.files = [];
      plan.parts.forEach((p, pi) => {
        const file = path.join(tmp, `s${si}-p${pi}.ts`);
        const dur = (p.to != null ? p.to : info.duration) - p.from;
        if (p.kind === 'enc') encodedSeconds += dur; else copiedSeconds += dur;
        const weight = p.kind === 'enc' ? dur * 6 + 0.5 : dur * 0.03 + 0.3;
        plan.files.push({ file, duration: p.to != null ? p.to - p.from : null });
        jobs.push({ kind: p.kind, part: p, file, dur, weight, done: 0 });
      });
      if (hasAudio) {
        plan.audio = path.join(tmp, `s${si}-audio.mka`);
        const dur = (plan.end != null ? plan.end : info.duration) - plan.start;
        jobs.push({ kind: 'audio', file: plan.audio, from: plan.start, to: plan.end, dur, weight: dur * 0.01 + 0.3, done: 0 });
      }
    });
    const totalWeight = jobs.reduce((a, j) => a + j.weight, 0) + 0.3 * plans.length;
    const report = () => onProgress(Math.min(0.99, jobs.reduce((a, j) => a + j.weight * j.done, 0) / totalWeight));

    const runJob = async (j) => {
      const onTime = (t) => { j.done = Math.max(0, Math.min(1, t / Math.max(0.05, j.dur))); report(); };
      if (j.kind === 'copy') {
        await copyRange('v', j.part.from, j.part.to, j.file, onTime);
      } else if (j.kind === 'audio') {
        await copyRange('a', j.from, j.to, j.file, onTime);
      } else {
        // Fastest encoder first (GPU); fall back down the list if it fails.
        for (;;) {
          const encoder = encoders[encoderIdx];
          try {
            await runFfmpeg(F.smartEncodeArgs({ input, output: j.file, from: j.part.from, to: j.part.to, info, encoder }), onTime);
            break;
          } catch (e) {
            if (e.message === 'cancelled' || encoderIdx >= encoders.length - 1) throw e;
            if (encoders[encoderIdx] === encoder) encoderIdx++;
          }
        }
      }
      j.done = 1;
      report();
    };

    // Encodes first (slowest), then copies; a few at once.
    const order = [...jobs].sort((a, b) => (a.kind === 'enc' ? 0 : 1) - (b.kind === 'enc' ? 0 : 1));
    await pool(order.map((j) => () => runJob(j)), Math.max(2, Math.min(4, os.cpus().length >> 1)));

    // 3. Join (stream copy only).
    const outputs = [];
    const mux = async (planList, out) => {
      const n = outputs.length;
      const vlist = path.join(tmp, `v-${n}.txt`);
      const lines = [];
      planList.forEach((pl, pi) => pl.files.forEach((f, fi) => {
        const last = pi === planList.length - 1 && fi === pl.files.length - 1;
        lines.push(F.concatLine(f.file, last ? null : f.duration));
      }));
      fs.writeFileSync(vlist, lines.join('\n'));
      let alist = null;
      if (hasAudio) {
        alist = path.join(tmp, `a-${n}.txt`);
        fs.writeFileSync(alist, planList.map((pl, i) => {
          const last = i === planList.length - 1;
          const d = (pl.end != null ? pl.end : info.duration) - pl.start;
          return F.concatLine(pl.audio, last ? null : d, last ? null : d);
        }).join('\n'));
      }
      try {
        await runFfmpeg(F.smartMuxArgs({ videoList: vlist, audio: alist, input, output: out, info }));
      } catch (e) {
        try { fs.unlinkSync(out); } catch {}
        for (const o of outputs) try { fs.unlinkSync(o); } catch {}
        throw e;
      }
      outputs.push(out);
    };

    if (opts.merge || plans.length === 1) {
      await mux(plans, opts.uniquePath(path.join(opts.outDir, `${opts.base}-trim${opts.ext}`)));
    } else {
      for (let i = 0; i < plans.length; i++) {
        await mux([plans[i]], opts.uniquePath(path.join(opts.outDir, `${opts.base}-cut${i + 1}${opts.ext}`)));
      }
    }
    onProgress(1);
    return { outputs, encodedSeconds, copiedSeconds };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { smartCut };
