# FrameCut

Fast video trimming with crop, zoom, stretch and resize. Windows desktop app built on Electron + FFmpeg.

## Download

Grab the latest build from [Releases](https://github.com/AntoVu/FrameCut/releases), unzip the whole folder
(don't run it from inside the zip) and double-click `FrameCut.exe`.

Windows may show "Windows protected your PC" because the app isn't code-signed.
Click **More info** → **Run anyway**. You only need to do this once.

## How it works

- **Trim only, "Frame-exact"** (default): smart cut. Cuts land on the exact frame you pick. Only the frames
  between each cut and the next keyframe (usually under a second) are re-encoded; everything else is copied
  losslessly, so it's nearly as fast as a plain copy.
- **Trim only, "Keyframe only"**: pure lossless copy like LosslessCut; cuts snap to keyframes.
- **Crop / zoom / stretch / resize / rotate**: re-encodes on your GPU (NVIDIA NVENC, Intel Quick Sync or
  AMD AMF are detected automatically), with frame-accurate cuts. The chip in the top-right shows which GPU
  encoder was found.
- The panel on the right always tells you which of the two will happen.

## Crop & zoom

- Drag the box or its handles on the video. Scroll the mouse wheel over the video to zoom around the cursor.
- Pick an aspect (16:9, 9:16, 1:1, 4:5 ...) to lock the shape.
- Output size "Original frame size (zoom in)" blows the cropped area back up to full size.
- Custom size + "Stretch" squashes/stretches; "Fit" adds black bars; "Fill" trims the edges.
- "Preview result" (or `P`) shows exactly what the export will look like.

## Frame-exact trimming

Step to the first frame you want and press `I`, then step to the last frame you want and press `O`.
Both of those frames are kept. The frame number is shown next to the time.

Frame-exact cuts of HEVC (H.265) videos are saved with the `hev1` tag. They play on Windows and most players,
but Apple's Photos/QuickTime may refuse them. For an iPhone-friendly file, use "Keyframe only", or export
with any crop/resize, which re-encodes the whole clip.

## Keyboard

| Key | Action |
|---|---|
| Space | play / pause |
| I / O | first / last frame to keep in the selected segment |
| + / Delete | add / remove a segment |
| Tab | next segment |
| Left / Right (or , and .) | step one frame; hold Shift for 1 second |
| Up / Down | jump to the first / last frame of the segment |
| P | toggle Preview result |
| Ctrl+O / Ctrl+E | open video / export |
| Mouse wheel on timeline | zoom it; Shift+wheel scrolls it |

## Output

Files are saved next to the original (e.g. `clip-edit.mp4`), or in a folder you choose with the
"Save next to source" button (right-click it to go back to saving next to the source).
With several segments, "Merge segments" joins them into one file; untick it for separate files.

## Run from source

Requires Node.js and FFmpeg (`ffmpeg.exe` and `ffprobe.exe`) either on your PATH or in an `ffmpeg/`
folder at the repo root.

```
npm install
npm start
```

## License

MIT. Release builds bundle FFmpeg, which is GPL-licensed (see `resources/ffmpeg/FFMPEG-LICENSE.txt` in the build).
