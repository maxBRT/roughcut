# Player spike: result

Spec 3.2 milestone 0, risk 4 in spec 2.8. Date: 2026-11-13.

## Verdict on risk 4

**Retired for the proxy, with two conditions. Partly retired for originals.**

- Two stacked `<video>` elements cross cuts within about one display refresh at 1x, 1.5x and 2x. Over 432 measured cuts there were no stalls and no audio dropouts away from cuts. With the swap applied 2 refreshes early, no wrong frame was seen in 216 cuts.
- **Condition 1:** the media server must send media with `Cache-Control: no-store`. With a cacheable response, Chromium let only one request per URL fetch at a time. The second element's seek then waited 1.6 to 21 s for the first element's streaming request to finish. This happened 6 times in 1008 cuts, plus one 4.4 s freeze during playback. With `no-store` it happened 0 times in 432 cuts, and the slowest prepare took 53 ms.
- **Condition 2:** apply the swap about 2 refreshes before the computed target. Applying it 1 refresh early showed the outgoing clip's next frame for one 144 Hz refresh (about 7 ms) at 5 of 288 cuts.
- **Originals:** H.264 8-bit, HEVC 8-bit, HEVC 10-bit (Main10) and even H.264 10-bit (High10) all play directly in Edge at 4K30, with 0 dropped frames in 4 s. Seeking is 5 to 13 times slower than on the proxy: median 47 to 128 ms against 10 ms. A new seek on every refresh gets almost no frames on screen. So the plan in spec 2.4.2 holds: play the original until the proxy is ready, then switch. The player must throttle seeks on originals (see "Scrubbing").
- The Electron fallback is not needed on this evidence. **The numbers come from Microsoft Edge 157.0.4341.46 in a normal window, not from the app's WebView2.** It is the same engine, but the app should run the same harness once inside WebView2 (milestone 1) before this verdict is final.

## How it was measured

- **Browser:** Microsoft Edge 157.0.4341.46, **normal window** (`--user-data-dir` temporary profile, closed after each run), started by `run_tests.py`. Flags: `--autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`.
- **Display:** 144 Hz. The refresh interval measured from `requestAnimationFrame` was 6.9 ms. Nothing was measured on a 60 Hz display.
- **Headless** (`--headless=new`) runs and decodes, but it is not representative: it heard no audio in the first run, and its pacing is not tied to a real display. Every number below comes from the windowed runs.
- **The machine was shared.** Other agents (a transcriber spike, CapCut and others) kept CPU load between 5 and 100 % during the runs. One windowed run is excluded from the cut table: the page produced no animation frames at all for 13.4 s (run `nsB`, 1.5x). That is a whole-renderer pause (window hidden or machine saturated), not a player event.
- **Frame identity:** every test frame carries a 13-bit binary marker: two rows of black and white blocks, and the second row is the complement of the first. On every animation frame the harness draws the top `<video>` element's marker area into a small canvas and decodes the frame number. A blended or torn frame fails the complement check and counts as "unreadable". **Limitation:** this samples the element's current frame on the main thread at rAF time, which closely approximates, but is not, the composited output.
- **Audio:** the right channel of the test media is a continuous 440 Hz tone. An AudioWorklet on the master bus records its RMS for every 128-sample quantum (2.7 ms). A "dip" is time below 1/3 of the steady level within -50 to +250 ms of a cut. During automated runs the master bus goes to a zero-gain sink, so nothing was played out loud. **Limitation:** this measures continuity only. It does not prove which source moment is heard, or audio-to-picture sync at the cut.
- **Test sequence** (`TEST_CLIPS` in `harness.js`): 25 clips and 24 cuts. It has forward and backward jumps (9 backward), 9 clips under 1 s, including clips of 3, 4, 5 and 6 frames, and clips of 1 to 3 s. Total 902 frames (30 s at 1x).

## Test media and proxy (task step 1)

`make_media.py` creates 120 s of 3840x2160 30 fps content: `testsrc2`, the binary marker, the burned-in frame number and time, a 1 kHz beep for the first 100 ms of every second (left channel) and the continuous 440 Hz tone (right channel). Encoded once and split three ways:

| File | Codec | Size |
| --- | --- | --- |
| `orig_h264_8bit.mp4` | H.264 High, yuv420p, NVENC 50 Mb/s, GOP 2 s | 757 MB |
| `orig_hevc_8bit.mp4` | HEVC Main, `hvc1` | 763 MB |
| `orig_hevc_10bit.mp4` | HEVC Main10, p010 | 766 MB |
| `orig_h264_10bit.mp4` | H.264 High10 (libx264), **30 s only** | 279 MB |

All media is in `.cache-dev/player/`. `check_media.py` confirmed that every proxy has 3600 frames, that frame k carries marker k (0 mismatches), and that keyframes are exactly 0.5 s apart.

### The proxy command (for the media module)

GPU (NVDEC + NVENC). `{FPS}` = the source frame rate, rounded to the sequence frame rate; `{GOP}` = round(FPS / 2):

```
ffmpeg -y -hide_banner -loglevel error -stats -hwaccel cuda -hwaccel_output_format cuda -i {IN} -map 0:v:0 -map 0:a:0? -vf scale_cuda=w=1280:h=720:format=yuv420p:interp_algo=bilinear -fps_mode cfr -r {FPS} -c:v h264_nvenc -preset p4 -profile:v high -rc vbr -cq 25 -b:v 2500k -maxrate 5M -bufsize 5M -g {GOP} -keyint_min {GOP} -bf 0 -forced-idr 1 -force_key_frames expr:gte(t,n_forced*0.5) -c:a aac -b:a 128k -ac 2 -ar 48000 -movflags +faststart {OUT}
```

Software:

```
ffmpeg -y -hide_banner -loglevel error -stats -i {IN} -map 0:v:0 -map 0:a:0? -vf scale=1280:720:flags=bilinear,format=yuv420p -fps_mode cfr -r {FPS} -c:v libx264 -preset veryfast -crf 23 -profile:v high -g {GOP} -keyint_min {GOP} -bf 0 -sc_threshold 0 -force_key_frames expr:gte(t,n_forced*0.5) -c:a aac -b:a 128k -ac 2 -ar 48000 -movflags +faststart {OUT}
```

Measured time for the 120 s 4K30 sources (warm file cache, shared machine). Run 1 used `-cq 23 -b:v 4M -maxrate 6M -bufsize 8M` on the GPU path. Run 2 is the command above.

| Source | GPU run 1 | GPU run 2 (final) | GPU s per source minute | Software run 1 | Software run 2 | Software s per source minute |
| --- | --- | --- | --- | --- | --- | --- |
| H.264 8-bit | 26.6 s (cold cache) | 18.1 s | **9.0** | 12.9 s | 18.6 s | 6.5 to 9.3 |
| HEVC 8-bit | 8.1 s | 8.3 s | **4.1** | 20.2 s | 26.2 s | 10.1 to 13.1 |
| HEVC 10-bit | 8.2 s | 8.5 s | **4.3** | 29.7 s | 37.8 s | 14.9 to 18.9 |

- **NVDEC is the bottleneck for 4K H.264.** Decoding alone (`-hwaccel cuda ... -f null -`) took 19.6 s for 3600 frames (about 184 fps). Software decode + scale + NVENC (the CPU command with `h264_nvenc` and the GPU encoder options) took **12.7 s** (6.3 s per source minute), measured once. For H.264 sources, the media module should prefer software decode + NVENC; for HEVC, full GPU.
- Extrapolating: 1 hour of 4K30 takes about 4 min (HEVC, GPU), about 6 to 9 min (H.264). This is an extrapolation from synthetic content, not a measurement. **The test pattern is far easier to encode than camera footage**, so software times on real footage will be worse.
- Proxy size: 52 MB for 2 min with the final GPU settings, about 1.5 GB per hour on this content (spec 2.4.2 assumed about 1 GB). The software proxy is 21 MB for 2 min.
- Not handled by this command, and needed by the media module: several audio tracks (it takes only track 0; spec says mix to stereo, so use `amix`), non-16:9 sources (`scale_cuda` stretches them; scale to 720 high with the width kept even, or pad), rotation metadata, and a non-zero source `start_time` (the proxy must keep the original's clock).

## Results: crossing cuts (task step 3)

Proxy `proxy_h264_8bit.mp4`, Edge window, server sending `no-store`, 144 Hz. "Ideal" is one frame duration at that rate. "Extra" is the time from the first sample showing the outgoing clip's last frame to the first sample showing the incoming clip's first frame, minus the ideal. Negative means the last frame was cut short; positive means it was held too long. Every value is quantised to the 6.9 ms refresh.

| Rate (ideal frame) | Swap lead | Runs / cuts | Extra: median (min .. max) | Wrong frame shown | Stalls | Last frame never shown | First incoming frame held, median (max) | Audio dip at cut, median (max) | Audio dropouts away from cuts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1x (33.3 ms) | 1 refresh | 4 / 96 | +1.4 ms (-5.6 .. +6.3) | 3 cuts, 1 refresh each | 0 | 0 | 21 ms (28) | 0 ms (5.3) | 0 |
| 1.5x (22.2 ms) | 1 | 3 / 72 * | -1.4 ms (-8.1 .. +5.5) | 1 cut, 1 refresh | 0 | 0 | 21 to 28 ms (42) | 0 to 2.7 ms (8.0) | 0 |
| 2x (16.7 ms) | 1 | 4 / 96 | -2.8 ms (-9.9 .. +4.1) | 1 cut, 1 refresh | 0 | 11 frames | 14 ms (28) | 0 to 4.0 ms (10.7) | 0 |
| **1x** | **2** | 2 / 48 | **-5.5 ms (-5.6 .. -5.4)** | **0** | 0 | 0 | 21 to 28 ms | 0 ms (5.3) | 0 |
| **1.5x** | **2** | 2 / 48 | **-8.3 ms (-15.3 .. -8.1)** | **0** | 0 | 0 | 21 ms | 0 to 2.7 ms (5.3) | 0 |
| **2x** | **2** | 2 / 48 | **-9.8 ms (-9.9 .. +4.1)** | **0** | 0 | 5 frames | 14 ms | 2.7 ms (10.7) | 0 |

\* The fourth 1.5x run (`nsB`) is excluded because of the 13.4 s renderer pause described above.

In an earlier set with the cacheable server (`w1`, one run per cell), lead 2 also showed 0 wrong frames over 72 cuts, and lead 0 showed a wrong frame at 9 of 24 cuts at 2x.

- **Every wrong frame was the outgoing element's next frame** (the first frame after the clip's end), shown for exactly one 144 Hz refresh. The incoming element never showed a stale frame, and no marker was unreadable (no blank, torn or blended frames) in any run.
- They happened mostly right after the tiny clips (3 and 6 frames), where the swap target rests on very few frame callbacks.
- With lead 2, the last frame of the outgoing clip is shortened by about 1 refresh. At 2x on 144 Hz, that sometimes means it is not shown at all: 5 of 48 cuts. That is a 16.7 ms frame at double speed and was judged acceptable. **On a 60 Hz display, 2 refreshes are 33 ms, which would drop a whole frame at 1x. The player should express the lead in milliseconds (about 7 to 10 ms plus one refresh), not in refreshes. This was not measured.**
- "First incoming frame held" is below the ideal (21 to 28 ms against 33 ms at 1x) because the incoming element starts playing as it is shown. The next frame comes up to 1 refresh early. This is not visible.
- Between cuts, frames were held 34.7 ms at 1x (the 144 Hz grid: 4 or 5 refreshes per frame), with a maximum of 48.6 ms.
- **Audio:** the per-element 5 ms gain ramps make most cuts dip-free (the tone never fell below 1/3 of its level), and the worst dip was 10.7 ms. No dropouts away from cuts. Not verified: clicks by ear, which source moment is heard, and audio-to-picture sync at the cut.

### Frame stepping and backwards play (proxy, 1x)

| Test | Runs | Result |
| --- | --- | --- |
| Step ±1 frame around 3 cuts (into 15-, 4- and 5-frame clips), 12 steps each way | 4 (`ns*`) | **288 / 288 steps showed the right frame**; step latency median 1.9 to 2.5 ms, max 18 ms |
| Silent backwards play (J), 1x, 4 s | 4 | 30.4 distinct frames per second, 120 sequence frames covered, 0 wrong or unreadable, never forwards |
| Silent backwards play, 2x, 4 s | 4 | 57.6 to 60.4 distinct frames per second (of 60 wanted), 240 frames covered, 0 wrong (under heavier machine load in `fin*`: 53 to 58) |

## Results: originals and proxies played directly (task step 4)

One `<video>`, Edge window, `no-store`. Seek = from setting `currentTime` to the frame callback of the new frame. 20 seeded random seeks; the marker was checked after each one.

| File | `canPlayType` / mediaCapabilities | First frame | Seek median / p90 / max | Correct frame after seek | Scrub, new seek every refresh (distinct frames/s) | Scrub, next seek only after `seeked` (seeks landed/s) | 4 s play at 1x |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Proxy (from H.264) | probably / smooth, power-efficient | 113 ms | **10 / 20 / 140 ms** | 20/20 | 122 | 178 | 120 frames, 0 dropped |
| Proxy (from HEVC 10-bit) | probably / smooth, power-efficient | 26 ms | **10 / 23 / 31 ms** | 20/20 | 117 | 172 | 0 dropped |
| Original H.264 8-bit 4K | probably / smooth, power-efficient | 52 ms | **80 / 180 / 199 ms** | 20/20 | 1 | 8 | 0 dropped |
| Original HEVC 8-bit 4K | probably / smooth, power-efficient | 154 ms | **47 / 89 / 106 ms** | 20/20 | 0.5 | 13.5 | 0 dropped |
| Original HEVC 10-bit 4K | probably / smooth, power-efficient | 72 ms | **57 / 91 / 101 ms** | 20/20 | 1 | 13 | 0 dropped |
| Original H.264 10-bit 4K (30 s) | probably / smooth, **not** power-efficient (software decode) | 144 ms | **128 / 207 / 269 ms** | 20/20 | 0 | n/a ** | 0 dropped, play start 75 ms |

\*\* The throttled scrub starts at 40 s, past the end of this 30 s file, so its number is meaningless.

An earlier seek run (same files) gave similar values: originals 45 to 138 ms median, proxy 9 to 10 ms.

- HEVC plays in this Edge without anything extra installed. **WebView2 may differ**, because HEVC support depends on the platform decoder. Check `canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"')` in the app.
- **Scrubbing:** on originals, a new seek on every refresh cancels the previous one, so almost nothing reaches the screen (0 to 1 frame per second). Issuing the next seek only after `seeked`, always to the latest drag position, gives 8 to 13.5 updates per second: usable but not smooth. That matches spec 2.6, "slower on the original". On the proxy both ways are smooth.

## The technique (what the player builder needs)

Code: `player.js` (`SequencePlayer`). `index.html` wires it to buttons and keys. Clips are `{src, start, end}` in source frames, end exclusive. The app's microseconds map as `frame = round(us * fps / 1e6)`.

1. **Two `<video>` elements in one positioned box**, both `position:absolute; inset:0`. The playing one has `z-index:2` and the other `z-index:1`. Both stay visible and in layout. Do not use `display:none` or `visibility:hidden` for the waiting element: it would not keep a decoded frame ready.
2. **Prepare the next clip on the hidden element:** `pause()`, then set `currentTime = frame / fps + 0.001`, and consider it ready on `seeked`. Chromium fires `seeked` after the pipeline has prerolled the frame. Measured with `no-store`: median 6 ms, p99 45 ms, max 53 ms (456 prepares).
   - **Pitfall:** seeking to the middle of the frame (`(k + 0.5) / fps`) shows the right frame, but `play()` then runs that frame for only half its duration (14 ms instead of 33 ms at 1x).
   - **Pitfall:** exactly `k / fps` can round into frame k-1.
3. **Timing source: `requestVideoFrameCallback` on the playing element.** Each callback gives `mediaTime` (the frame) and `expectedDisplayTime`. The swap target is `expectedDisplayTime + (clip.end - frame) * (1000 / fps / rate)`: the moment the first frame after the clip would reach the screen. Recompute it on every callback, not only on the last frame. At 2x on short clips, the last frame's callback arrives too late to act on.
4. **Apply the swap from a `requestAnimationFrame` loop:** swap in the first rAF where `t + lead * refresh >= target - refresh / 2`. `refresh` is a running average of rAF deltas; `lead = 2` (see the table for lead 1).
   - Swap = set the incoming element's `z-index` to 2 and the outgoing one's to 1; set `playbackRate`; register the frame callback on the incoming element; `play()` it; run the audio ramps.
   - After `rampMs + 2` ms: `pause()` the outgoing element and prepare it for the clip after next.
   - Safety net: if a frame callback ever reports a frame at or past `clip.end`, cut immediately.
5. **Audio ramp:** each element goes `createMediaElementSource` → its own `GainNode` → master gain → destination. At the swap: `cancelScheduledValues(t)`; the outgoing gain does `setValueAtTime(current, t)` then `linearRampToValueAtTime(0, t + 5 ms)`; the incoming gain does `setValueAtTime(0, t)` then `linearRampToValueAtTime(1, t + 5 ms)`, with `t = ctx.currentTime`. Element `volume` was not tried; Web Audio was clean and is sample-accurate. A paused or waiting element's gain stays at 0. Needs an `AudioContext` resumed by a user gesture (or the autoplay flag in tests).
6. **Not ready in time** (next clip shorter than its prepare): `pause()` the outgoing element on its last frame and swap when `seeked` arrives. This never happened in the 432 final cuts. In a diagnostic run that has since been deleted, it happened once, for 20 ms, at 2x into a 5-frame clip.
7. **Rates:** `playbackRate` 1, 1.5 or 2 on both elements. `preservesPitch` is true by default in Chromium and is set explicitly. 1.5x on a 60 Hz display will judder (45 fps on 60 Hz). That is inherent and was not measured here.
8. **Step:** pause, then `seek(seqFrame ± n)`. Seek uses the hidden element directly if it already holds that frame; otherwise it re-prepares the visible element. Result: 288/288 correct, median about 3 ms.
9. **Backwards (J):** master gain 0. Loop: target = start - elapsed * fps * rate; `await seek(target)`. That is one seek in flight at a time, latest target wins. Result: 30 frames/s at 1x, 58 to 60 at 2x, on the proxy.
10. **Server:** byte ranges (206), `Accept-Ranges: bytes`, and **`Cache-Control: no-store` on media.** Capping open-ended ranges at 4 MB did not help (`wcap*`: 3 stalls in 6 runs).

## What did not work, or was ruled out

- **Cacheable media responses** (`max-age=3600`) caused rare multi-second seek hangs: 6 in 1008 cuts, plus a 4.4 s freeze during playback. During a hang the element reported `seeking`, readyState 1 and `buffered` covering the whole file. It recovered only after the browser's 3 s `stalled` timeout. The server log showed the new range request was sent only when the other element's long streaming request for the same URL ended. This matches Chromium's single-writer HTTP cache entry per URL. `no-store` removed the problem (0 in 432). Giving each element its own URL (for example `?e=0` and `?e=1`) would probably work too; it was not tested.
- **Re-issuing the stuck seek** (watchdog, `watchdogRetry`) did not unstick it (`rtA`: a 3.6 s prepare even with a retry every 400 ms). The watchdog remains in `player.js` only as a diagnostic event.
- **Capped range responses** (`--cap-mb 4`): no improvement.
- **Swap lead 0** (swap only when the target is reached): the outgoing next frame was visible at 9 of 24 cuts at 2x. **Lead 1:** at 5 of 288 cuts. **Lead 2:** at 0 of 216.
- **Headless Edge** for timing: it runs, but has no real display pacing and audio behaved differently (no tone was heard in the first run), so its numbers are not used.

## Files

| File | What |
| --- | --- |
| `player.js` | The technique: `SequencePlayer` (load, play, pause, seek, step, setRate, shuttleBack; `onFrame` every displayed frame) |
| `index.html` | Prototype page with manual controls (Space/K, J, L, arrow keys with Shift for 1 s, rate buttons); `?suite=seq` or `?suite=seek` runs the measurements |
| `harness.js`, `audio-tap.js` | Measurement only: marker reader, per-refresh sampler, audio RMS tap, scenarios |
| `server.py` | Local server: byte ranges, `no-store`, results upload, request log |
| `run_tests.py` | Starts the server and an Edge window (or headless) with a temporary profile, waits for results, closes everything |
| `analyze.py` | Turns `results/*.json` into the numbers above (`results/summary.json`) |
| `make_media.py`, `check_media.py` | Test media, proxies and timings; frame-exact check of a file |
| `results/` | Raw data. `ns*` and `l2*`: final runs (`no-store`). `fin*`, `rt*`, `wcap*`, `wnocap*`, `w1*`: cacheable server (stall evidence, and lead 0/1/2 in `w1`). `sk*`: originals. `hl*`: headless |

Re-run: `python run_tests.py --mode window --suite seq --tag X --query "rates=1,1.5,2&leads=2"`, then `python analyze.py X`. For the originals: `--suite seek`.

## Not done or not verified

- Not run in WebView2 or in the Tauri shell; only in Edge.
- No 60 Hz display measurement; the lead should be re-checked there.
- Not run on the user's real footage. Spec 2.8 asks for this; only synthetic media was available.
- No listening test for clicks. The audio check is the level of a steady tone.
- Two sources in one sequence (the hidden element changing `src` at a cut) was not tested. Every clip came from one proxy.
- Switching from the original to the proxy while keeping the position was not tested.
