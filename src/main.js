const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const F = require('./ffmpeg');
const { smartCut } = require('./smartcut');

const exe = (name) => {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = path.join(process.resourcesPath || '', 'ffmpeg', file);
  if (app.isPackaged && fs.existsSync(bundled)) return bundled;
  const local = path.join(__dirname, '..', 'ffmpeg', file);
  if (fs.existsSync(local)) return local;
  return name; // fall back to PATH
};
const FFMPEG = () => exe('ffmpeg');
const FFPROBE = () => exe('ffprobe');

let win;
let current = null; // running export: { proc, cancelled }

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#131416',
    title: 'FrameCut',
    autoHideMenuBar: true,
    show: !process.env.FRAMECUT_HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (process.env.FRAMECUT_SCREENSHOT) {
    win.webContents.on('console-message', (ev) => console.log(`[renderer] ${ev.message || ''}`));
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open a file passed on the command line ("Open with FrameCut").
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a));
  const testFile = process.env.FRAMECUT_TEST_FILE || arg;
  win.webContents.on('did-finish-load', () => {
    if (testFile) win.webContents.send('open-path', path.resolve(testFile));
  });

  if (process.env.FRAMECUT_SCREENSHOT) {
    const shots = process.env.FRAMECUT_SCREENSHOT.split(',');
    const script = process.env.FRAMECUT_TEST_SCRIPT || '';
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500));
      for (let i = 0; i < shots.length; i++) {
        if (script) {
          const steps = script.split('||');
          if (steps[i]) await win.webContents.executeJavaScript(steps[i]).catch((e) => console.error(e));
          await new Promise((r) => setTimeout(r, 900));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shots[i], img.toPNG());
      }
      app.quit();
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- helpers ----------
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout, stderr });
    });
  });
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 2; i < 1000; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  return p;
}

// ---------- IPC ----------
ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm', 'ts', 'mts', 'm2ts', 'wmv', 'flv', '3gp'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('probe', async (_e, file) => {
  const r = await run(FFPROBE(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error((r.stderr || 'Could not read this file.').trim().split('\n').pop());
  const info = F.parseProbe(JSON.parse(r.stdout));
  return { ...info, url: pathToFileURL(file).href, name: path.basename(file), dir: path.dirname(file) };
});

let encoderCache = null;
ipcMain.handle('detect-encoders', async () => {
  if (encoderCache) return encoderCache;
  const test = async (id) => {
    const r = await run(FFMPEG(), [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2',
      '-frames:v', '3', '-c:v', id, '-f', 'null', '-',
    ]);
    return r.code === 0;
  };
  const out = {};
  for (const codec of Object.keys(F.ENCODERS)) {
    const list = F.ENCODERS[codec];
    const ok = await Promise.all(list.map((e) => (e.hw ? test(e.id) : Promise.resolve(true))));
    out[codec] = list.filter((_, i) => ok[i]);
  }
  encoderCache = out;
  return out;
});

// Low-res preview copy for formats Chromium can't play (e.g. some MKV/AVI/HEVC).
ipcMain.handle('make-proxy', async (_e, file) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecut-'));
  const out = path.join(dir, 'preview.mp4');
  const args = [
    '-hide_banner', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
    '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
  ];
  const r = await run(FFMPEG(), args);
  if (r.code !== 0) throw new Error('Could not create a preview for this file.');
  return pathToFileURL(out).href;
});

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('cancel-export', () => {
  if (current) {
    current.cancelled = true;
    for (const p of current.procs) try { p.kill(); } catch {}
  }
});

function runFfmpeg(args, onTime) {
  return new Promise((resolve, reject) => {
    if (current && current.cancelled) return reject(new Error('cancelled'));
    const proc = spawn(FFMPEG(), args, { windowsHide: true });
    if (current) current.procs.add(proc);
    let err = '';
    proc.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/g;
      let x;
      let last = null;
      while ((x = m.exec(d.toString()))) last = x[1];
      if (last && onTime) onTime(Number(last) / 1e6);
    });
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (current) current.procs.delete(proc);
      if (current && current.cancelled) return reject(new Error('cancelled'));
      if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `FFmpeg exited with code ${code}`));
    });
  });
}

// job = { input, info, edit, segments:[{start,end}], merge, encoder, quality, ext, outDir }
ipcMain.handle('export', async (e, job) => {
  const send = (msg) => e.sender.send('export-progress', msg);
  current = { cancelled: false, procs: new Set() };
  const frameEdits = F.needsReencode(job.info, job.edit);
  const precise = job.trimMode !== 'keyframe';
  const smart = !frameEdits && precise && F.canSmartCut(job.info);
  // Frame-exact trim of a codec we can't smart-cut (VP9, AV1, ProRes...) → full re-encode.
  const force = !frameEdits && precise && !smart;
  const reencode = frameEdits || force;
  const base = path.basename(job.input, path.extname(job.input));
  let ext = job.ext === 'same' ? path.extname(job.input) || '.mp4' : `.${job.ext}`;
  if (force && !/^\.(mp4|mov|m4v|mkv)$/i.test(ext)) ext = '.mp4';
  const outDir = job.outDir || path.dirname(job.input);
  const segs = job.segments.filter((s) => s.end - s.start > 0.05);
  const total = segs.reduce((a, s) => a + (s.end - s.start), 0) || 1;
  const outputs = [];
  const temps = [];
  let done = 0;
  const started = Date.now();

  try {
    if (smart) {
      const res = await smartCut({
        input: job.input, info: job.info, segments: segs, merge: job.merge, ext, outDir, base,
        encoders: job.smartEncoders || [], ffmpeg: FFMPEG(), ffprobe: FFPROBE(), run, runFfmpeg,
        onProgress: (p) => send({ phase: 'segment', index: 0, count: 1, progress: p }), uniquePath,
      });
      return {
        ok: true, outputs: res.outputs, seconds: (Date.now() - started) / 1000, reencode: false, smart: true,
        encodedSeconds: res.encodedSeconds, copiedSeconds: res.copiedSeconds,
      };
    }
    if (reencode && job.merge && segs.length > 1) {
      // One pass: decode each piece, crop/scale, join, encode.
      const out = uniquePath(path.join(outDir, `${base}-edit${ext}`));
      outputs.push(out);
      const args = F.mergeEncodeArgs({
        input: job.input, output: out, segments: segs, info: job.info, edit: job.edit,
        encoder: job.encoder, quality: job.quality,
      });
      send({ phase: 'segment', index: 0, count: 1, progress: 0 });
      await runFfmpeg(args, (t) => send({ phase: 'segment', index: 0, count: 1, progress: Math.min(1, t / total) }));
      return { ok: true, outputs, seconds: (Date.now() - started) / 1000, reencode };
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let out;
      if (job.merge && segs.length > 1) {
        out = path.join(outDir, `.${base}.framecut-part${i}${ext}`);
        temps.push(out);
      } else {
        const suffix = segs.length > 1 ? `-cut${i + 1}` : frameEdits ? '-edit' : force ? '-trim' : '-cut';
        out = uniquePath(path.join(outDir, `${base}${suffix}${ext}`));
        outputs.push(out);
      }
      const args = F.segmentArgs({
        input: job.input, output: out, start: s.start, end: s.end, force,
        info: job.info, edit: job.edit, encoder: job.encoder, quality: job.quality,
      });
      send({ phase: 'segment', index: i, count: segs.length, progress: done / total });
      await runFfmpeg(args, (t) => send({ phase: 'segment', index: i, count: segs.length, progress: Math.min(1, (done + t) / total) }));
      done += s.end - s.start;
    }
    if (job.merge && segs.length > 1) {
      send({ phase: 'merge', progress: 0.99 });
      const list = path.join(outDir, `.${base}.framecut-list.txt`);
      temps.push(list);
      fs.writeFileSync(list, temps.filter((t) => t !== list).map((t) => `file '${t.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const out = uniquePath(path.join(outDir, `${base}-${reencode ? 'edit' : 'cut'}${ext}`));
      await runFfmpeg(F.concatArgs(list, out));
      outputs.push(out);
    }
    return { ok: true, outputs, seconds: (Date.now() - started) / 1000, reencode };
  } catch (err) {
    for (const o of outputs) try { fs.unlinkSync(o); } catch {}
    if (err.message === 'cancelled') return { ok: false, cancelled: true };
    return { ok: false, error: err.message };
  } finally {
    for (const t of temps) try { fs.unlinkSync(t); } catch {}
    current = null;
  }
});
