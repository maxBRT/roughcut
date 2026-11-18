# Roughcut

Roughcut turns an hour of talking-head or screen recording into a rough cut quickly.
You import the recording, read its transcript and delete the bad takes as text, put a couple of
clips end to end on a simple timeline, and export one MP4. Claude (through your Claude
subscription) suggests retakes and dead air to cut; you accept or dismiss each with one key.

## Get it

Download the installer from the
**[latest release](https://github.com/maxBRT/roughcut/releases/latest)**
(`Roughcut_<version>_x64-setup.exe`) and run it. It installs for your user only, with no
administrator rights, and adds Roughcut to the Start menu. Windows may warn that the installer
is from an unknown publisher (it is not code-signed): choose "More info", then "Run anyway".

Needs Windows 10 or 11 and an NVIDIA graphics card with a current driver (export uses it).

**Updates:** an installed copy checks GitHub when it starts. When a newer release exists, a line
at the bottom of the window says so; "update and restart" saves your project, installs the new version and
reopens the app.

A build made from the source also runs without installing: `dist-app\Roughcut\Roughcut.exe`
(made by `npm run package`). That copy does not update itself.

## Start it

- Drop a recording on the window, or press `Ctrl+N`, to make a project. You can play it at once;
  the transcript appears within seconds and fills in as it goes.
- The very first transcript on a PC downloads the speech model (about 0.5 GB) once; the line
  under the player shows its progress. On this PC the model and the graphics-card speech runtime
  are already in place, so nothing is downloaded and transcripts are made on the graphics card.
- Suggestions need Claude Code installed and signed in. If they do not appear, run `claude`
  once in a terminal and sign in.

## Ship a new version

From the project folder, in PowerShell:

```powershell
.\release.ps1                          # next patch version, for example 0.1.4 -> 0.1.5
.\release.ps1 minor --notes "What changed"
```

It builds and signs the installer, pushes the code, and publishes a GitHub release. Installed
copies offer the update at their next start. It needs the signing key in
`%USERPROFILE%\.tauri\roughcut.key` (keep a copy: without it, installed copies cannot be
updated) and this PC signed in to GitHub for git. Details are in `scripts/release.mjs`.

## The ten keys worth knowing

Press `?` in the app for all of them (they can be changed there).

| Key | What it does |
| --- | --- |
| `Space` | Play / pause |
| `Delete` | Transcript: cut the selected words (or the word at the caret). Timeline: remove the clip under the playhead |
| `Shift` + arrows | Select words in the transcript |
| `I` / `O` | Mark the start / end of a range at the playhead, by ear |
| `N`, then `A` or `D` | Go to the next suggestion, then accept it (cut) or dismiss it (keep) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo, any number of times |
| `Tab` | Switch between the Transcript and the Timeline |
| `S` | Timeline: split at the playhead |
| `J` `K` `L`, `1` `2` `3` | Back / pause / forward, and speed 1x / 1.5x / 2x |
| `Ctrl+E` | Export (then `Enter` to start) |

## Where things are kept

| What | Where |
| --- | --- |
| Projects and settings | `%APPDATA%\Roughcut` |
| Cache: preview copies, audio, transcripts, waveforms | `%LOCALAPPDATA%\Roughcut\cache` (it has a size limit; clearing it never touches your recordings) |
| Speech model and graphics-card speech runtime | `%LOCALAPPDATA%\Roughcut\speech` (about 5.5 GB on this PC) |
| Window data | `%LOCALAPPDATA%\app.roughcut.editor` |
| Exports | Your Videos folder, or the folder you pick in the Export dialog |

Your recordings are never moved, changed or copied into these folders. To remove everything,
close Roughcut and delete `dist-app\Roughcut`, `%APPDATA%\Roughcut`, `%LOCALAPPDATA%\Roughcut`
and `%LOCALAPPDATA%\app.roughcut.editor` (paste each into the File Explorer address bar).
Nothing else was written: no registry entries, shortcuts or PATH changes.

## Known limits

- Export needs the NVIDIA graphics card (it encodes on it). It runs at about 3 times real time
  for 4K, so 40 minutes of 4K takes about 13 minutes.
- A 10-bit H.264 recording is exported as HEVC (10-bit), because the card cannot encode 10-bit
  H.264. The Export dialog says so.
- Suggestions for an hour-long recording took about 2 minutes in testing (the goal was 1).
- In the player, sound runs about 65 ms behind the picture. The exported file is in sync.
- Playing backwards (`J`) is silent and steps through frames.
- Some recordings (for example `.mkv`) cannot play until their preview copy is made, which takes
  seconds for short files and a few minutes for an hour of 4K.
- On another PC the folder transcribes on the processor (an hour in about 3 to 4 minutes),
  because the 2.3 GB graphics-card speech runtime is not in the folder; it was copied into
  `%LOCALAPPDATA%\Roughcut\speech` on this PC only.
- A long suggestion reason is cut off with "…"; hover over it to read all of it.

Developers: see `BUILD.md`.

## Included programs

The installer includes `ffmpeg.exe` and `ffprobe.exe` (FFmpeg 9.0.2 full build from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/), GPL; licence in `ffmpeg-LICENSE.txt`, source at
[ffmpeg.org](https://ffmpeg.org/download.html)) and the transcriber with sherpa-onnx and ONNX
Runtime (Apache-2.0 / MIT). The speech model, downloaded on first use, is NVIDIA Parakeet TDT
0.6B v2 (CC-BY-4.0).
