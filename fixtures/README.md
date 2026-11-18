# Test media fixtures

Generated media for the `media`, export, player, speech and whole-app tests (spec 3.7, "Fixtures").
Nothing here is checked in except the generators; the media lives in `fixtures/out/` (git-ignored).

## Regenerate

```
npm run fixtures                                  # = node fixtures/generate.mjs
node fixtures/generate.mjs                        # make every fixture that does not exist yet
node fixtures/generate.mjs --only numbered-vfr    # one fixture (comma separated or repeated for more)
node fixtures/generate.mjs --force                # rebuild (combine with --only for one)
node fixtures/generate.mjs --list                 # names and purposes
```

Needs on PATH: `ffmpeg`/`ffprobe` with `h264_nvenc` and `libx265` (source `tools/env.sh` or `tools/env.ps1`),
and Windows PowerShell with System.Speech (built into Windows) for the speech fixture.
A full build takes about 5 minutes on the dev PC (the HDR fixture is CPU-encoded and takes about 80 s; the VFR fixture about 50 s).

Every file is checked with ffprobe/ffmpeg before it is moved into place (frame count, frame
timestamps, frame rate mode, stream layout, codec, bit depth, HDR signalling, beep onsets and pitch, silence).
A failed check exits non-zero and leaves no output file. The results of each check are kept in the manifest.

## The fixtures

All picture fixtures show the frame index (0-based, 5 digits) large in the centre, a small label with the
fixture name and timestamp top-left, and an orange square moving along the bottom (so encoders see motion).
Beep tracks carry a 100 ms sine tone at amplitude 0.5 starting exactly on every whole second
(sample 48000·k, which is also the first frame of that second) and digital silence between.
Audio is AAC 48 kHz in MP4.

| Name | File | Picture | Audio | Used for |
| --- | --- | --- | --- | --- |
| `numbered-4k-h264` | `numbered-4k-h264.mp4` | 3840×2160, 30 fps CFR, 900 frames, H.264 High 8-bit (h264_nvenc, constant QP 20, GOP 60, 2 B-frames) | stereo, 1000 Hz beeps | export, proxy, player |
| `numbered-4k-hevc10-hdr` | `numbered-4k-hevc10-hdr.mp4` | as above in HEVC Main10, yuv420p10le, `hvc1`, BT.2020 / PQ (smpte2084) / bt2020nc, HDR10 mastering-display and MaxCLL 1000 / MaxFALL 400 SEI (libx265, because hevc_nvenc cannot take HDR10 static metadata from the command line) | stereo, 1000 Hz beeps | export keeps bit depth and HDR |
| `numbered-vfr` | `numbered-vfr.mp4` | 3840×2160, genuinely variable timing on a 1/60 s grid: 0–8 s 30 fps, 8–14 s alternating 33/50 ms (24 fps average), 14–18 s 60 fps, 18–24 s 30 fps with a dropped frame every 0.2 s, 24–30 s 20 fps. 894 frames, every whole second has a frame. Per-frame timestamps are in the manifest. | stereo, 1000 Hz beeps, 30 s | conversion to CFR keeps time |
| `numbered-3audio` | `numbered-3audio.mp4` | as `numbered-4k-h264` | track 0 stereo 1000 Hz "Main mix (1000 Hz)" (default), track 1 mono 500 Hz "Lav mic (500 Hz)", track 2 mono 2000 Hz "Camera mic (2000 Hz)" | all tracks kept; track choice |
| `numbered-1080p60` | `numbered-1080p60.mp4` | 1920×1080, 60 fps CFR, 1800 frames, H.264 | stereo, 1000 Hz beeps | mixed sources follow the first clip |
| `silence-only` | `silence-only.mp4` | 1920×1080, 30 fps, 20 s, 600 frames, H.264 | stereo, all samples exactly zero | "No speech" state |
| `speech-2min` | `speech-2min.mp4` + `speech-2min.wav` | 1920×1080 30 fps numbered card, 127.6 s | the synthesised voice: AAC 48 kHz stereo in the mp4 (title "Voice"); the exact signal as 16 kHz mono 16-bit PCM in the wav | speech, suggestions, whole-app run |

Track titles: MP4 stores a track title in the track's `udta/name` box; ffprobe reports it as tag `name`
(and the generator also sets `handler_name`), not `title`. Readers should look at `title`, then `name`, then `handler_name`.

### speech-2min

No real recording is available, so the speech is synthesised with Windows System.Speech (voice
"Microsoft David Desktop", falling back to any installed voice) from the script in `speech-script.mjs`:
a weekly design-team update with

- 4 retake groups (A, C with three takes; B, D with two). The **last take** of each group is the one to keep.
- 3 false starts ("So the onboarding", "And in the mean", "The offsite is on"), each followed by the full line.
- 2 asides ("Wait, let me redo that.", "Sorry, hang on, I lost my notes. Okay.").
- fillers (um, uh, you know, like, so, okay).
- long pauses of 2.5 s, 3.0 s and 2.2 s, and one of 6.0 s.

Each line is synthesised separately, trimmed to its audible extent (threshold about −42 dBFS) and placed after
digital silence, so the manifest's `startSec`/`endSec` for every line are exact (sample accurate at 16 kHz).
Word start times come from the synthesiser's progress events and are approximate (tens of milliseconds);
a word's end is the next word's start. Synthesised speech is cleaner than a real recording: it has no
breaths or room noise and the gaps are true digital silence. Spec 3.7 plans a fixture cut from a real
recording in milestone 0; this one stands in until then.

## manifest.json

`fixtures/out/manifest.json`. Paths are relative to the project root.

```
{
  schema: 1, generatedAt, ffmpeg: "<ffmpeg -version first line>", outDir: "fixtures/out", pathsRelativeTo: "project root",
  fixtures: {
    "<name>": {
      name, file: "<name>.mp4", path: "fixtures/out/<name>.mp4", purpose, sizeBytes,
      durationSec, durationUs,               // nominal (exact) length
      containerDurationSec, container,       // as ffprobe reports
      video: { codec, profile, encoder, width, height, pixFmt, bitDepth,
               frameRate: "30/1", avgFrameRate, fps (null for VFR), frameRateMode: "cfr"|"vfr", frameCount, timeBase,
               colorPrimaries, colorTransfer, colorSpace, colorRange,
               hdr: null | { standard: "HDR10", masteringDisplay: {primaries, whitePoint, maxLuminanceNits, minLuminanceNits},
                              contentLightLevel: {maxCLL, maxFALL} },
               burnIn, frameTimestampsSec?: [..] /* VFR only */ },
      audioTracks: [ { index, streamIndex, codec, sampleRate, channels, channelLayout, title, titleTags, default,
                       durationSec, silent,
                       beep: null | { freqHz, durationSec: 0.1, amplitude: 0.5, onsetsSec: [0,1,..], measuredMaxOnsetErrorMs } } ],
      checks: [ { check, ok, detail } ],
      generatedAt, buildSeconds,
      // speech-2min only:
      extraFiles: { wav16k: { file, path, codec, sampleRate: 16000, channels: 1, bitsPerSample: 16, durationSec, sizeBytes, note } },
      speech: {
        source, timeBase, totalSec, leadInSec,
        sentences: [ { id: "s01", index, kind: "normal"|"retake"|"false_start"|"aside", text,
                       startSec, endSec, startUs, endUs, startSample16k, endSample16k,
                       retakeGroup, take, takes, keep, fillers: [{filler, wordIndex}],
                       words: [{ text, norm, startSec, endSec }], wordTimes } ],
        gaps: [ { afterSentence, beforeSentence, startSec, endSec, durationSec } ],
        longPauses: [ ...gaps longer than 2 s ],
        retakeGroups: [ { group, sentences: [ids], keep: id } ],
        falseStarts: [ids], asides: [ids],
        fullText, keptText,                  // keptText = normal lines + last take of each retake group
        expectedWords: [ { sentence, text, norm, startSec, endSec } ]
      }
    }
  }
}
```

## verify.mjs

Helpers for tests (Node built-ins, ffmpeg/ffprobe on PATH):

| Export | What it does |
| --- | --- |
| `readManifest()`, `fixturePath(name)` | read the manifest; absolute path of a fixture |
| `probe(file)` | ffprobe format + streams as JSON |
| `countFrames(file, {stream, decode=true})` | exact decoded frame count (`decode:false` counts packets, faster) |
| `frameTimestamps(file, {stream, decode=false})` | ascending presentation time of every frame, seconds |
| `frameRateSummary(timestamps)` | min/max frame interval and whether the rate is constant |
| `decodeAudio(file, {track, sampleRate, channel})` | one audio track as mono Float32 PCM |
| `findBeeps(file, opts)` / `findBeepsInSamples(samples, rate, opts)` | beeps as `{onset, end, duration, freqHz, peak}` |
| `findBeepOnsets(file, {track})` | beep onset times in seconds |
| `audioPeak(file, {track})` | peak sample value (0 means digital silence) |
| `frameAt(t, fps)` | which numbered frame is shown at time t in a CFR fixture |

Typical A/V alignment check on an export: the beep onsets (`findBeepOnsets`) should fall within one
frame of the timestamps of the frames whose source index is a multiple of the frame rate.
