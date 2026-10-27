# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

FrameCut is a Windows Electron app for fast video trimming with crop, zoom, stretch, resize, rotate and flip, built on FFmpeg. No build step, no bundler, no tests, no linter.

## Commands

- `npm install` then `npm start`: run from source. Needs `ffmpeg.exe`/`ffprobe.exe` on PATH or in `ffmpeg/` at the repo root (gitignored).
- `npm run package`: builds `out\FrameCut-win32-x64` with electron-packager, bundling `ffmpeg/` as an extra resource (the folder must exist).

## Architecture

- `src/main.js`: main process. Resolves ffmpeg/ffprobe (bundled resource → repo `ffmpeg/` → PATH), owns all `ipcMain.handle` channels (probe, detect-encoders, make-proxy, export, cancel-export, dialogs) and spawns FFmpeg.
- `src/preload.js`: exposes those channels to the renderer as `window.api`.
- `src/ffmpeg.js`: pure logic shared by both sides. Loaded with `require` in main and as a plain `<script>` in the renderer, where it sets `window.FF` (see the `module.exports` / `window.FF` switch at the bottom). Keep it free of Node/Electron APIs. It turns the `edit` object (`{crop, rotate, flipH, flipV, size, fit}`) into an FFmpeg filter chain (`buildVideoFilters`), parses ffprobe output and builds export args.
- `src/smartcut.js`: frame-exact trim without full re-encode. Re-encodes only the frames between each cut and the next keyframe, stream-copies the rest, then concatenates.
- `src/renderer/app.js`: single IIFE holding all UI state in `S`. `refresh()` is the central redraw; `plan()` calls `FF.buildVideoFilters` so the UI and the export always agree.

### Export modes

No filters + "Keyframe only" → lossless copy. No filters + "Frame-exact" → smart cut (if `FF.canSmartCut`), else full re-encode. Any crop/resize/rotate → GPU re-encode (NVENC/QSV/AMF detected at startup, CPU fallback).

### Edit view geometry

The crop is stored normalized (0–1) in oriented **source-frame** space, before rotation/flip. The edit view is a viewfinder: `fitView` applies a `DOMMatrix` (flip → rotate → scale → translate) to the whole `#viewport`, so the crop box and its handles are drawn in source space and turned with the frame. Consequences:
- Pointer input goes through `toNorm()` (the inverse of that matrix).
- Anything that must stay screen-aligned has to compensate: `--inv` keeps handles and outline a constant screen size; the `swapEdges`/`swapCorners` classes swap the resize cursors; the crop label is simply hidden when rotated/flipped.
- Aspect presets swap a:b on 90°/270° turns (`aspectValue`).

## Conventions

- Deliberate shortcuts are marked with `ponytail:` comments naming the limit and the upgrade path.
- Keep README.md (user-facing features and keyboard shortcuts) in sync when behavior changes.
