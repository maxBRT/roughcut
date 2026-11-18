# rc-media

Core module `media` (spec 3.3, 3.5.9): every FFmpeg task. Only `jobs` calls these tasks, and
`source` calls `probe`. Every task blocks, so `jobs` runs it on a worker thread. Every task
takes explicit output paths, because the `cache` crate decides where files go.

## Modules

| Module | What it does |
| --- | --- |
| `tools` | `FfmpegTools::locate(dir)` finds `ffmpeg` and `ffprobe`. It looks in the explicit folder first, then `ROUGHCUT_FFMPEG_DIR`, then the executable's folder (also `ffmpeg\` and `ffmpeg\bin\` under it), then `PATH`. It also reads the version. |
| `process` | The runner every task uses. `run_ffmpeg` starts one process with `-progress pipe:1` and reports `TaskProgress { fraction, seconds_left }`. A `CancelToken` kills the process, and the files named in `RunSpec.partial_outputs` are then removed. The last 25 lines of stderr become `AppError.detail`. Children start with `CREATE_NO_WINDOW` and stdin closed, and are always reaped. They also sit in a kill-on-close job object, so they die with the app. `in_progress_path(out)` returns `<out>.part`. |
| `probe` | `probe(tools, path, cancel) -> MediaInfo`. It runs ffprobe twice: once for streams and format, once for the video packet times. Variable frame rate is decided from the real packet intervals, compared with the declared rate's interval; one tick of rounding is allowed when the time base cannot hold that interval exactly (Matroska's 1 ms base stores 60 fps as 17/17/16 ms). Files over 90 s are scanned in three 20 s windows. It also reads bit depth, HDR (PQ/HLG transfer or HDR side data), rotation and pixel aspect (width and height are the displayed size), and track titles (`title`, then `name`, then a non-default `handler_name`). `speechTrack` comes from `choose_speech_track`, which matches title hints and falls back to the first track. `directPlayable` is true for MP4/MOV with H.264 or HEVC in a 4:2:0 pixel format (8 or 10 bit) and AAC/MP3/Opus/FLAC audio; 4:2:2 and 4:4:4 wait for the proxy. |
| `proxy` | `make_proxy(tools, &ProxyRequest, cancel, on_progress)`. Makes a 1280x720 H.264 copy with a keyframe every 0.5 s, no B-frames and constant frame rate (`-fps_mode cfr`, which keeps wall-clock time for VFR sources). The picture keeps its shape, with black bars, and rotation is applied. HDR is tone-mapped to SDR BT.709. Every audio track is put on the shared clock (`aresample=async=1:first_pts=0`, so a late track keeps its delay) and mixed into one stereo AAC track. The GPU path is NVDEC+NVENC for 4:2:0 HEVC/AV1/VP9, and software decode + NVENC for H.264, 4:2:2 and rotated sources (the player spike found that faster for H.264; NVDEC cannot decode 4:2:2 here). If NVDEC+NVENC fails, software decode + NVENC is tried next; only when NVENC itself fails does it fall back to libx264 and report `gpu_unavailable`. Output goes to `.part` and is renamed when done. |
| `speech_audio` | `start_speech_audio(tools, &SpeechAudioRequest, cancel) -> SpeechAudioStream`. The stream implements `Read` and yields 16 kHz mono s16le PCM of one track while FFmpeg is still running. It can also save a WAV copy. Call `finish()` at the end. Dropping the stream kills FFmpeg and removes the partial WAV. |
| `waveform` | `make_waveform(tools, &WaveformRequest, cancel, on_progress) -> WaveformHeader`. Writes a file of peak loudness values at 240 values per second with `rc_types::write_waveform`. |

## Conventions every task keeps

- **Time zero is the source's first video frame.** `MediaInfo.duration` runs from that frame to
  the end of the longest stream. When the container starts earlier (for example, audio priming
  or a late picture), tasks pass `-ss <offset>` as an input option. Proxy, speech audio and
  waveform therefore share the original's clock, as spec 2.4.2 requires.
- Speech audio has exactly `speech_samples_for(duration)` samples: `apad` adds silence at the
  end and `-t` trims the excess.
- The waveform has exactly `ceil(duration x 240)` values.
- `AudioTrackInfo.index` counts audio tracks only, which matches FFmpeg's `0:a:N`.
- Errors: `source_missing`, `source_unreadable`, `cancelled`, `disk_full`, `gpu_unavailable`
  (GPU-only proxy, or the GPU failure that `ProxyOutcome.gpu_failure` reports), and `internal`
  with FFmpeg's last error lines as the detail.

## Why 240 waveform values per second

240 is a whole multiple of 24, 30, 48, 60, 120 and 240 fps. At those rates every frame covers a
whole number of values (8 at 30 fps, 4 at 60 fps), so a frame-level trim lines up with the
drawn sound. A 100 ms beep shows as 24 values. An hour is 864 KB.

## Export (`export`)

The method and settings of the export experiment (`spikes/export/RESULT.md`), clip by clip:

| Function | What it does |
| --- | --- |
| `plan_export(tools, &ExportSpec, cancel) -> ExportPlan` | One ffprobe per source. `format` follows the first clip (`output_format`): its displayed size, its frame rate when that is a whole multiple of the sequence rate (`output_frame_rate`: a 60 fps first clip in a 30 fps sequence exports at 60 fps, each sequence frame becoming two; otherwise the sequence rate, with a notice), its bit depth, HDR and number of audio tracks; HEVC stays HEVC, other 8-bit codecs become H.264, and 10-bit or HDR becomes HEVC Main10 (`h264_nvenc` cannot encode 10-bit here). Size and time from the experiment's model, with a floor of 3 Mb/s (H.264) or 2.5 Mb/s (HEVC) at 4K30 for sources coded at very low rates; `free_bytes` at the destination. `blocked_by`: `nothing_to_export`, `source_missing` (file named), `source_unreadable`, `disk_full` (amount needed and free in the message; the pieces and the PCM sound count too when the temporary folder is on the destination's drive, and the disk check allows the video to come out 1.5 times the estimate, never above the codec's rate ceiling), `export_failed` for an unusable file name or a destination that is one of the sources (compared resolved and case-insensitively). Notices: sources differ, 10-bit H.264, VFR converted, fewer audio tracks. |
| `run_export(tools, &ExportSpec, cancel, on_progress) -> ExportResult` | Plans again and refuses with `blocked_by`. Encodes the pieces two at a time while the sound renders, then joins. Progress is frames encoded over the sequence's frames, then the join (weighted by the time model). Cancel kills every FFmpeg at once. The temporary folder `rc-export-<pid>-<ns>` under `ExportSpec.work_root` is removed in every outcome; the MP4 is written as `<destination>.part` and renamed only when complete. |
| `encode_clip(tools, &PieceRequest, cancel, on_progress)` | One clip to one piece: `-noaccurate_seek -ss <start - 1 s> -copyts` (for index-less containers such as MPEG-TS, where a fast seek lands on the keyframe after its target, a one-frame `showinfo` decode picks the first pre-roll of 1, 4, 15, 60 s or none that lands at or before the clip; any piece that comes out short after a seek is encoded again with the next pre-roll), `fps` onto the sequence grid, `tpad` (repeats the last frame only if the source ends early), `trim` on frame slots, NVENC cq 19 p4 with the experiment's options (`-b_ref_mode disabled` for H.264, `middle` for HEVC, `-maxrate`/`-bufsize` at the level limit), the same MP4 timescale everywhere, colour tags of the first clip. NVDEC with frames on the GPU (and `scale_cuda` for another size or bit depth) for 4:2:0 H.264 8-bit/HEVC/AV1/VP9 of the output's shape and HDR state; otherwise, or when NVDEC fails, processor decode with scale/pad and tone mapping (HDR to SDR) or PQ placement (SDR to HDR). The piece's packet count is checked against the clip's frames. NVENC failing: `gpu_unavailable` with FFmpeg's error tail. |
| `render_audio(tools, &AudioRenderRequest, cancel, on_progress)` | Every track of the whole sequence in one run, as a filter script (`-/filter_complex`): one `amovie` per clip, `aresample=48000:async=1:min_comp=0.00001:first_pts=<seek point>` (a late track keeps its delay), `atrim` in samples from the cumulative frame count, `apad`, 4 ms fades. Missing tracks of a source are silence. Paths are escaped for both filter levels (quotes, brackets, commas work). |
| `join(tools, &JoinRequest, cancel, on_progress) -> bytes` | Concat demuxer with exact `duration` lines, `-c:v copy` (`-tag:v hvc1` for HEVC), AAC 256 kb/s per track (more above four channels), `+faststart`, to `<out>.part`, renamed when done. |

`prepare_source` reads what the tasks need beyond `MediaInfo` (stream indices, start times, bit
rate, channel layouts, colour tags) once per source. `ClipFrames::from_clip` turns a `Clip` into
grid frames with `rc_types::grid`.

## Tests

`cargo test -p rc-media` with ffmpeg and ffprobe on `PATH` (source `tools/env.sh`) and the
fixtures generated (`npm run fixtures`). `tests/probe_fixtures.rs` checks every fixture against
`fixtures/out/manifest.json`. `tests/proxy_fixtures.rs` checks constant frame rate, keyframes
exactly every 0.5 s, duration within one frame, the VFR, HDR and three-track fixtures, cancel,
forced software, the GPU fallback, and a rotated 4:3 late-starting source.
`tests/audio_fixtures.rs` covers the speech stream's length, alignment and track choice,
cancel and drop, the waveform's beeps at whole seconds, and a waveform cancelled while FFmpeg runs.
`tests/export_fixtures.rs` (spec 3.7, the Export row; NVENC needed) makes marker sources once into
`%TEMP%/rc-media-export-src-v1` (the experiment's 16-block frame code, beeps on every second) and
checks exact frames on both sides of every cut, regular picture timestamps, every track present and
as long as the picture, every beep where the cut puts it and sync at the end, format kept (H.264,
HEVC Main10 HDR10 with metadata on every frame), VFR to CFR by the `fps` rule, mixed sizes, rates,
track counts and HDR/SDR, a late track, odd paths, GPU decode fallback, encoder failure, cancel,
the disk-space check (and, on the 4K fixtures, that the estimate is not below the real size and the check covers the real peak), the blocked plans, an .m2ts with 5 s between keyframes, a 60 fps first clip in a 30 fps sequence, an export onto a source file, and that the processor and GPU decode every output frame
the same. `speed_on_the_4k_fixtures` prints the speed (`--nocapture`). The tests take the GPU one
at a time.
`tests/review_media.rs` (from the review) covers a late second track in the mix, 60 fps Matroska as
constant frame rate, 4:2:2 not direct playable, and an HEVC 4:2:2 proxy that still uses NVENC.
