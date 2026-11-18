#!/usr/bin/env node
// Generates Roughcut's test media into fixtures/out/ and writes fixtures/out/manifest.json.
//
//   node fixtures/generate.mjs                 make every fixture that does not exist yet
//   node fixtures/generate.mjs --only <name>   make one fixture (repeatable, or comma separated)
//   node fixtures/generate.mjs --force         rebuild even if the file exists
//   node fixtures/generate.mjs --list          list fixture names
//
// Node built-ins only. Needs ffmpeg/ffprobe on PATH (h264_nvenc, libx265) and, for
// speech-2min, Windows PowerShell with System.Speech.
// Every file is verified with ffprobe/ffmpeg before it is moved into place; a failed
// check aborts with a non-zero exit code and leaves no output file behind.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, ffprobeJson, writeWav16, readWav16 } from './lib/proc.mjs';
import {
  countFrames, frameTimestamps, frameRateSummary, findBeeps, findBeepsInSamples, decodeAudio, audioPeak,
} from './verify.mjs';
import {
  SCRIPT, VOICE_PREFERENCE, SPEECH_RATE, LEAD_IN_SEC, TAIL_SEC, tokenize, normWord, fillersIn,
} from './speech-script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'out');
const TMP = join(OUT, '.tmp');

const AUDIO_RATE = 48000;
const BEEP_SEC = 0.1;
const BEEP_AMP = 0.5;

// ---------------------------------------------------------------- helpers

const rel = (p) => relative(ROOT, p).split('\\').join('/');
const log = (...a) => console.log('[fixtures]', ...a);

function fontArg() {
  const win = (process.env.WINDIR || 'C:/Windows').split('\\').join('/');
  for (const f of ['consolab.ttf', 'consola.ttf', 'arialbd.ttf', 'arial.ttf']) {
    const p = `${win}/Fonts/${f}`;
    if (existsSync(p)) return `'${p.replace(/:/g, '\\:')}'`;
  }
  throw new Error('no usable font found in %WINDIR%/Fonts');
}

/**
 * Filter graph for the numbered picture: big 5-digit frame index (0-based, counted after
 * any select), a small label with the timestamp, and an orange square moving left to right.
 */
function pictureGraph({ w, h, fps, dur, label, fg = 'white', select = null }) {
  const box = Math.round(h / 9);
  const speed = Math.round(w * 0.4);
  const big = Math.round(h * 0.32);
  const small = Math.round(h / 28);
  const f = fontArg();
  let g =
    `color=c=0x101418:s=${w}x${h}:r=${fps}:d=${dur}[bg];` +
    `color=c=0xff9900:s=${box}x${box}:r=${fps}:d=${dur}[box];` +
    `[bg][box]overlay=x='mod(t*${speed},W-w)':y=H-h-${Math.round(h / 18)}:shortest=1:eval=frame,format=yuv420p`;
  if (select) g += `,select='${select}'`;
  g += `,drawtext=fontfile=${f}:text='%{eif\\:n\\:d\\:5}':fontsize=${big}:fontcolor=${fg}:x=(w-tw)/2:y=(h-th)/2`;
  g += `,drawtext=fontfile=${f}:text='${label}   t=%{pts\\:hms}':fontsize=${small}:fontcolor=${fg}:x=${small}:y=${small}`;
  g += '[v]';
  return g;
}

/** Beep WAV: a `freq` Hz tone of BEEP_SEC starting exactly at every whole second, silence between. */
function makeBeepWav(path, { durSec, freq, channels }) {
  const n = Math.round(durSec * AUDIO_RATE);
  const beepLen = Math.round(BEEP_SEC * AUDIO_RATE);
  const s = new Int16Array(n * channels);
  for (let i = 0; i < n; i++) {
    const k = i % AUDIO_RATE;
    const v = k < beepLen ? Math.round(BEEP_AMP * 32767 * Math.sin((2 * Math.PI * freq * k) / AUDIO_RATE)) : 0;
    for (let c = 0; c < channels; c++) s[i * channels + c] = v;
  }
  writeWav16(path, s, AUDIO_RATE, channels);
}

function silentWav(path, { durSec, channels }) {
  writeWav16(path, new Int16Array(Math.round(durSec * AUDIO_RATE) * channels), AUDIO_RATE, channels);
}

const H264_NVENC = (fps) => [
  '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'constqp', '-qp', '20',
  '-profile:v', 'high', '-g', String(fps * 2), '-bf', '2',
];

async function ffmpeg(args) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

async function encode({ graph, inputs, maps, videoArgs, audioArgs, extra = [], out, cfrFps }) {
  const graphFile = join(TMP, `graph-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(graphFile, graph);
  const fpsArgs = cfrFps ? ['-fps_mode', 'cfr', '-r', String(cfrFps)] : ['-fps_mode', 'passthrough'];
  await ffmpeg([
    ...inputs.flatMap((i) => ['-i', i]),
    '-/filter_complex', graphFile,
    '-map', '[v]', ...maps,
    ...videoArgs, ...fpsArgs, ...audioArgs, ...extra,
    '-movflags', '+faststart', out,
  ]);
  rmSync(graphFile, { force: true });
}

function bitDepthOf(stream) {
  const raw = Number(stream.bits_per_raw_sample);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const m = /p(\d+)(le|be)?$/.exec(stream.pix_fmt || '');
  return m ? Number(m[1]) : 8;
}

class Checks {
  constructor(name) { this.name = name; this.list = []; }
  add(check, ok, detail) {
    this.list.push({ check, ok: !!ok, detail: String(detail) });
    log(`  ${ok ? 'ok  ' : 'FAIL'} ${check}: ${detail}`);
  }
  assertAll() {
    const bad = this.list.filter((c) => !c.ok);
    if (bad.length) {
      throw new Error(`${this.name}: ${bad.length} check(s) failed:\n` + bad.map((c) => `  - ${c.check}: ${c.detail}`).join('\n'));
    }
  }
}

/**
 * Verify a produced file against expectations and describe it for the manifest.
 * expect: { durationSec, width, height, codec, bitDepth, fps (cfr) | vfrTimestamps (vfr),
 *           frameCount, audio: [{ channels, freq?, silent?, title? }], hdr? }
 */
async function verifyAndDescribe(file, name, expect) {
  const C = new Checks(name);
  const pj = await ffprobeJson(file, ['-show_format', '-show_streams']);
  const vs = pj.streams.filter((s) => s.codec_type === 'video');
  const as = pj.streams.filter((s) => s.codec_type === 'audio');
  C.add('stream layout', vs.length === 1 && as.length === expect.audio.length,
    `${vs.length} video, ${as.length} audio (expected 1, ${expect.audio.length})`);
  const v = vs[0];
  C.add('video codec', v.codec_name === expect.codec, v.codec_name);
  C.add('resolution', v.width === expect.width && v.height === expect.height, `${v.width}x${v.height}`);
  const depth = bitDepthOf(v);
  C.add('bit depth', depth === expect.bitDepth, `${depth} bit (${v.pix_fmt})`);

  const frames = await countFrames(file, { decode: true });
  C.add('decoded frame count', frames === expect.frameCount, `${frames} (expected ${expect.frameCount})`);
  const packets = await countFrames(file, { decode: false });
  C.add('packet count', packets === expect.frameCount, `${packets}`);

  const ts = await frameTimestamps(file);
  const sum = frameRateSummary(ts);
  C.add('first frame at 0', ts.length > 0 && Math.abs(ts[0]) < 1e-6, `first pts ${ts[0]}`);
  let frameRateMode;
  if (expect.fps) {
    frameRateMode = 'cfr';
    const d = 1 / expect.fps;
    C.add('constant frame rate', sum.constant && Math.abs(sum.minDelta - d) < 5e-4,
      `frame interval min ${(sum.minDelta * 1000).toFixed(3)} ms, max ${(sum.maxDelta * 1000).toFixed(3)} ms (expected ${(d * 1000).toFixed(3)})`);
    C.add('declared frame rate', v.r_frame_rate === `${expect.fps}/1` && v.avg_frame_rate === `${expect.fps}/1`,
      `r_frame_rate ${v.r_frame_rate}, avg_frame_rate ${v.avg_frame_rate}`);
    const end = ts[ts.length - 1] + d;
    C.add('picture duration', Math.abs(end - expect.durationSec) < 1e-3, `last frame ends at ${end.toFixed(4)} s`);
  } else {
    frameRateMode = 'vfr';
    const exp = expect.vfrTimestamps;
    let maxErr = 0;
    for (let i = 0; i < Math.min(exp.length, ts.length); i++) maxErr = Math.max(maxErr, Math.abs(exp[i] - ts[i]));
    C.add('frame timestamps match plan', ts.length === exp.length && maxErr < 1e-3, `max error ${(maxErr * 1000).toFixed(3)} ms over ${ts.length} frames`);
    const distinct = new Set(sum.deltas.map((x) => Math.round(x * 6000))).size;
    C.add('frame timing is variable', !sum.constant && distinct >= 3,
      `${distinct} distinct intervals, ${(sum.minDelta * 1000).toFixed(2)} to ${(sum.maxDelta * 1000).toFixed(2)} ms`);
    const lastEnd = ts[ts.length - 1];
    C.add('picture spans 30 s wall clock', lastEnd > expect.durationSec - 0.1 && lastEnd < expect.durationSec, `last frame at ${lastEnd.toFixed(4)} s`);
  }
  const fdur = Number(pj.format.duration);
  C.add('container duration', Math.abs(fdur - expect.durationSec) < 0.05, `${fdur} s (expected ${expect.durationSec})`);

  let hdr = null;
  if (expect.hdr) {
    const okColor = v.color_primaries === 'bt2020' && v.color_transfer === 'smpte2084' && v.color_space === 'bt2020nc';
    C.add('HDR10 colour signalling', okColor, `primaries ${v.color_primaries}, transfer ${v.color_transfer}, matrix ${v.color_space}, range ${v.color_range}`);
    const fj = await ffprobeJson(file, ['-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames']);
    const sd = (fj.frames?.[0]?.side_data_list || []);
    const types = sd.map((s) => s.side_data_type);
    const md = sd.find((s) => /Mastering display/i.test(s.side_data_type || ''));
    const cll = sd.find((s) => /Content light level/i.test(s.side_data_type || ''));
    const frac = (x) => { const [a, b] = String(x).split('/').map(Number); return b ? a / b : a; };
    C.add('HDR10 static metadata (SEI)', md && cll,
      md && cll ? `mastering display ${frac(md.min_luminance)}-${frac(md.max_luminance)} nits, MaxCLL ${cll.max_content}, MaxFALL ${cll.max_average}` : (types.join(', ') || 'none'));
    hdr = {
      standard: 'HDR10',
      masteringDisplay: md ? {
        primaries: 'BT.2020', whitePoint: 'D65',
        maxLuminanceNits: frac(md.max_luminance), minLuminanceNits: frac(md.min_luminance),
      } : null,
      contentLightLevel: cll ? { maxCLL: cll.max_content, maxFALL: cll.max_average } : null,
    };
  }

  const audioTracks = [];
  for (let i = 0; i < as.length; i++) {
    const a = as[i];
    const e = expect.audio[i] || {};
    // MP4 keeps a track title in the track's udta "name" box (ffprobe tag "name") and in the
    // handler name; "title" is what Matroska/MOV readers report. Accept any of them.
    const title = a.tags?.title ?? a.tags?.name ?? (a.tags?.handler_name !== 'SoundHandler' ? a.tags?.handler_name : null) ?? null;
    C.add(`audio ${i} format`, a.codec_name === 'aac' && Number(a.sample_rate) === AUDIO_RATE && a.channels === e.channels,
      `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch`);
    if (e.title) C.add(`audio ${i} title`, title === e.title, `"${title}"`);
    let beep = null;
    if (e.silent) {
      const peak = await audioPeak(file, { track: i });
      C.add(`audio ${i} digital silence`, peak === 0, `peak ${peak}`);
    } else if (e.freq) {
      const beeps = await findBeeps(file, { track: i });
      const nExp = Math.round(expect.durationSec);
      let maxOn = 0, maxFreq = 0, maxDur = 0;
      beeps.forEach((b, k) => {
        maxOn = Math.max(maxOn, Math.abs(b.onset - k));
        maxFreq = Math.max(maxFreq, Math.abs(b.freqHz - e.freq) / e.freq);
        maxDur = Math.max(maxDur, Math.abs(b.duration - BEEP_SEC));
      });
      C.add(`audio ${i} beep count`, beeps.length === nExp, `${beeps.length} (expected ${nExp})`);
      C.add(`audio ${i} beep onsets on whole seconds`, maxOn < 0.0015, `max onset error ${(maxOn * 1000).toFixed(3)} ms`);
      C.add(`audio ${i} beep pitch`, maxFreq < 0.03, `${e.freq} Hz, max deviation ${(maxFreq * 100).toFixed(2)} %`);
      C.add(`audio ${i} beep length`, maxDur < 0.004, `max deviation ${(maxDur * 1000).toFixed(2)} ms`);
      beep = {
        freqHz: e.freq, durationSec: BEEP_SEC, amplitude: BEEP_AMP,
        onsetsSec: Array.from({ length: nExp }, (_, k) => k),
        measuredMaxOnsetErrorMs: +(maxOn * 1000).toFixed(3),
      };
    }
    audioTracks.push({
      index: i, streamIndex: a.index, codec: a.codec_name, sampleRate: Number(a.sample_rate),
      channels: a.channels, channelLayout: a.channel_layout ?? null, title,
      titleTags: title ? Object.fromEntries(Object.entries(a.tags || {}).filter(([k, val]) => val === title)) : {},
      default: a.disposition?.default === 1, durationSec: Number(a.duration), beep, silent: !!e.silent,
    });
  }

  C.assertAll();
  return {
    sizeBytes: statSync(file).size,
    durationSec: expect.durationSec,
    durationUs: Math.round(expect.durationSec * 1e6),
    containerDurationSec: fdur,
    container: pj.format.format_name,
    video: {
      codec: v.codec_name, profile: v.profile ?? null, encoder: expect.encoder,
      width: v.width, height: v.height, pixFmt: v.pix_fmt, bitDepth: depth,
      frameRate: v.r_frame_rate, avgFrameRate: v.avg_frame_rate, fps: expect.fps ?? null,
      frameRateMode, frameCount: frames, timeBase: v.time_base,
      colorPrimaries: v.color_primaries ?? null, colorTransfer: v.color_transfer ?? null,
      colorSpace: v.color_space ?? null, colorRange: v.color_range ?? null, hdr,
      burnIn: 'frame index, 0-based, 5 digits, centre; small label with fixture name and timestamp top-left; orange square moving along the bottom',
      ...(frameRateMode === 'vfr' ? { frameTimestampsSec: ts.map((t) => +t.toFixed(6)) } : {}),
    },
    audioTracks,
    checks: C.list,
  };
}

// ---------------------------------------------------------------- numbered fixtures

function numberedFixture({ name, purpose, w, h, fps, dur = 30, tracks, video = 'h264', vfr = false }) {
  return {
    name, purpose, file: `${name}.mp4`,
    async build(final, partial) {
      const wavs = tracks.map((t, i) => {
        const p = join(TMP, `${name}-a${i}.wav`);
        if (t.silent) silentWav(p, { durSec: dur, channels: t.channels });
        else makeBeepWav(p, { durSec: dur, freq: t.freq, channels: t.channels });
        return p;
      });
      const maps = tracks.flatMap((_, i) => ['-map', `${i}:a`]);
      const audioArgs = ['-c:a', 'aac'];
      tracks.forEach((t, i) => {
        audioArgs.push(`-b:a:${i}`, t.channels === 1 ? '128k' : '192k');
        audioArgs.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');
        if (t.title) audioArgs.push(`-metadata:s:a:${i}`, `title=${t.title}`, `-metadata:s:a:${i}`, `handler_name=${t.title}`);
      });

      let graph, videoArgs, encoder, frameCount, vfrTimestamps = null;
      const label = `${name}  ${w}x${h}`;
      if (vfr) {
        // 60 fps grid, thinned by segment: 30 fps / alternating 33-50 ms / 60 fps / 30 fps with drops / 20 fps.
        // Every whole second keeps its frame, so the beep still falls on a frame start.
        const srcFps = 60;
        const keep = (n) => (n < 480 ? n % 2 === 0
          : n < 840 ? (n % 5 === 0 || n % 5 === 2)
            : n < 1080 ? true
              : n < 1440 ? (n % 2 === 0 && n % 12 !== 6)
                : n % 3 === 0);
        const sel = 'if(lt(n,480),not(mod(n,2)),if(lt(n,840),eq(mod(n,5),0)+eq(mod(n,5),2),' +
          'if(lt(n,1080),1,if(lt(n,1440),not(mod(n,2))*not(eq(mod(n,12),6)),not(mod(n,3))))))';
        vfrTimestamps = [];
        for (let n = 0; n < dur * srcFps; n++) if (keep(n)) vfrTimestamps.push(n / srcFps);
        frameCount = vfrTimestamps.length;
        graph = pictureGraph({ w, h, fps: srcFps, dur, label: `${label}  VFR`, select: sel });
        videoArgs = H264_NVENC(30);
        encoder = 'h264_nvenc';
      } else {
        frameCount = dur * fps;
        if (video === 'hevc10-hdr') {
          // HDR10: PQ + BT.2020 in the VUI and mastering-display / content-light SEI. hevc_nvenc
          // cannot take explicit HDR10 static metadata from the command line, so libx265 is used.
          // Text is mid grey (about 200 nits in PQ) rather than full white (10 000 nits).
          graph = pictureGraph({ w, h, fps, dur, label: `${label}  HEVC 10-bit HDR10`, fg: '0x949494' });
          graph = graph.replace(/\[v\]$/, ',format=yuv420p10le[v]');
          videoArgs = [
            '-c:v', 'libx265', '-preset', 'fast', '-crf', '18', '-profile:v', 'main10', '-pix_fmt', 'yuv420p10le',
            '-tag:v', 'hvc1',
            '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv',
            '-x265-params',
            'log-level=error:keyint=60:min-keyint=60:bframes=3:hdr10=1:repeat-headers=1:' +
            'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited:' +
            'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
          ];
          encoder = 'libx265';
        } else {
          graph = pictureGraph({ w, h, fps, dur, label });
          videoArgs = H264_NVENC(fps);
          encoder = 'h264_nvenc';
        }
      }
      log(`  encoding ${w}x${h} ${vfr ? 'VFR' : fps + ' fps'} with ${encoder}...`);
      await encode({ graph, inputs: wavs, maps, videoArgs, audioArgs, out: partial, cfrFps: vfr ? null : fps });
      wavs.forEach((p) => rmSync(p, { force: true }));

      const desc = await verifyAndDescribe(partial, name, {
        durationSec: dur, width: w, height: h, codec: video === 'hevc10-hdr' ? 'hevc' : 'h264',
        bitDepth: video === 'hevc10-hdr' ? 10 : 8, fps: vfr ? null : fps, vfrTimestamps, frameCount,
        audio: tracks, hdr: video === 'hevc10-hdr', encoder,
      });
      return desc;
    },
  };
}

// ---------------------------------------------------------------- speech fixture

const SPEECH_SR = 16000;

function speechFixture() {
  const name = 'speech-2min';
  return {
    name, file: `${name}.mp4`, extraFiles: [`${name}.wav`],
    purpose: 'About two minutes of synthesised speech (Windows System.Speech) with planted retakes, false starts, asides, fillers and long pauses; ground truth for speech, suggestions and the whole-app run.',
    async build(final, partial) {
      const work = join(TMP, 'speech');
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const items = SCRIPT.map((s, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, text: s.text, wav: join(work, `s${i + 1}.wav`) }));
      const jobFile = join(work, 'job.json');
      const resultFile = join(work, 'result.json');
      writeFileSync(jobFile, JSON.stringify({ voices: VOICE_PREFERENCE, rate: SPEECH_RATE, result: resultFile, items }));
      log(`  synthesising ${items.length} lines with System.Speech...`);
      await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'lib', 'tts.ps1'), '-Job', jobFile]);
      const result = JSON.parse(readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''));
      const resultItems = Array.isArray(result.items) ? result.items : [result.items];

      // Assemble: lead-in, then each trimmed line followed by its gap of digital silence.
      const THR = 250; // about -42 dBFS: below this the TTS output is treated as silence
      const parts = [];
      let pos = Math.round(LEAD_IN_SEC * SPEECH_SR);
      const sentences = [];
      const groupTakes = {};
      SCRIPT.forEach((s, i) => { if (s.group) (groupTakes[s.group] ||= []).push(i); });
      for (let i = 0; i < SCRIPT.length; i++) {
        const s = SCRIPT[i];
        const it = items[i];
        const wav = readWav16(it.wav);
        if (wav.sampleRate !== SPEECH_SR || wav.channels !== 1) throw new Error(`TTS gave ${wav.sampleRate} Hz ${wav.channels} ch, expected 16000 mono`);
        let a = 0, b = wav.samples.length - 1;
        while (a < wav.samples.length && Math.abs(wav.samples[a]) <= THR) a++;
        while (b > a && Math.abs(wav.samples[b]) <= THR) b--;
        if (a >= b) throw new Error(`line ${it.id} synthesised to silence`);
        const clip = wav.samples.subarray(a, b + 1);
        const start = pos;
        const end = pos + clip.length;
        parts.push({ at: start, clip });

        // Word starts from the synthesiser's progress events, mapped onto the script tokens.
        const tokens = tokenize(s.text);
        const ri = resultItems.find((r) => r.id === it.id);
        const evs = ri ? (Array.isArray(ri.words) ? ri.words : ri.words ? [ri.words] : []) : [];
        const evNorm = evs.map((e) => normWord(String(e.text)));
        const aligned = evNorm.length === tokens.length && evNorm.every((n, k) => n === tokens[k].norm);
        const words = tokens.map((t, k) => {
          let ws = null;
          if (aligned) {
            const samp = Math.round(evs[k].ms * SPEECH_SR / 1000) - a;
            ws = Math.min(Math.max(start + samp, start), end) / SPEECH_SR;
          }
          return { text: t.text, norm: t.norm, startSec: ws === null ? null : +ws.toFixed(4) };
        });
        if (aligned) {
          for (let k = 0; k < words.length; k++) {
            const next = k + 1 < words.length ? words[k + 1].startSec : end / SPEECH_SR;
            words[k].endSec = +next.toFixed(4);
          }
        } else {
          log(`  note: word events for ${it.id} did not match the script tokens (${evNorm.join(' ')}); word times omitted`);
        }
        const takes = s.group ? groupTakes[s.group] : null;
        const kept = s.kind === 'normal' || (s.kind === 'retake' && takes[takes.length - 1] === i);
        sentences.push({
          id: it.id, index: i, kind: s.kind, text: s.text,
          startSec: +(start / SPEECH_SR).toFixed(4), endSec: +(end / SPEECH_SR).toFixed(4),
          startUs: Math.round(start * 1e6 / SPEECH_SR), endUs: Math.round(end * 1e6 / SPEECH_SR),
          startSample16k: start, endSample16k: end,
          retakeGroup: s.group ?? null, take: takes ? takes.indexOf(i) + 1 : null, takes: takes ? takes.length : null,
          keep: kept, fillers: fillersIn(s.text),
          words, wordTimes: aligned ? 'start of each word from System.Speech SpeakProgress events (approximate, about +-30 ms); end = next word start' : null,
        });
        pos = end + Math.round(s.gapAfter * SPEECH_SR);
      }
      let total = Math.round(sentences[sentences.length - 1].endSample16k + TAIL_SEC * SPEECH_SR);
      total = Math.ceil(total / 1600) * 1600; // whole 0.1 s, so whole frames at 30 fps and whole samples at 16/48 kHz
      const pcm = new Int16Array(total);
      for (const p of parts) pcm.set(p.clip, p.at);
      const totalSec = total / SPEECH_SR;

      const wavPartial = join(OUT, `${name}.partial.wav`);
      writeWav16(wavPartial, pcm, SPEECH_SR, 1);

      // Picture: a simple numbered card, 1080p30, same length as the audio.
      const fps = 30;
      const graph = pictureGraph({ w: 1920, h: 1080, fps, dur: totalSec, label: `${name}  1920x1080` });
      log(`  encoding ${totalSec.toFixed(1)} s card with h264_nvenc...`);
      await encode({
        graph, inputs: [wavPartial], maps: ['-map', '0:a'], videoArgs: H264_NVENC(fps),
        audioArgs: ['-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2', '-metadata:s:a:0', 'title=Voice', '-metadata:s:a:0', 'handler_name=Voice'],
        out: partial, cfrFps: fps,
      });

      const desc = await verifyAndDescribe(partial, name, {
        durationSec: totalSec, width: 1920, height: 1080, codec: 'h264', bitDepth: 8, fps,
        frameCount: Math.round(totalSec * fps), audio: [{ channels: 2, title: 'Voice' }], encoder: 'h264_nvenc',
      });

      // Ground-truth sanity: speech where the script says, (near) silence in the gaps, in both files.
      const C = new Checks(name);
      const wavProbe = await ffprobeJson(wavPartial, ['-show_streams', '-show_format']);
      const ws = wavProbe.streams[0];
      C.add('wav format', ws.codec_name === 'pcm_s16le' && Number(ws.sample_rate) === 16000 && ws.channels === 1,
        `${ws.codec_name} ${ws.sample_rate} Hz ${ws.channels} ch, ${Number(wavProbe.format.duration).toFixed(3)} s`);
      C.add('wav duration', Math.abs(Number(wavProbe.format.duration) - totalSec) < 1e-3, `${wavProbe.format.duration} s`);
      const dec = await decodeAudio(partial, { sampleRate: SPEECH_SR });
      const rms = (arr, s0, s1) => {
        let acc = 0; const a = Math.max(0, s0), b = Math.min(arr.length, s1);
        for (let i = a; i < b; i++) acc += arr[i] * arr[i];
        return Math.sqrt(acc / Math.max(1, b - a));
      };
      let minSpeech = Infinity, maxGapPeak = 0;
      const gaps = [];
      for (let k = 0; k < sentences.length; k++) {
        const s = sentences[k];
        minSpeech = Math.min(minSpeech, rms(dec.samples, s.startSample16k, s.endSample16k));
        const gs = s.endSample16k;
        const ge = k + 1 < sentences.length ? sentences[k + 1].startSample16k : total;
        const margin = 800; // 50 ms, AAC smearing at the edges
        for (let i = gs + margin; i < ge - margin; i++) maxGapPeak = Math.max(maxGapPeak, Math.abs(dec.samples[i] || 0));
        gaps.push({
          afterSentence: s.id, beforeSentence: k + 1 < sentences.length ? sentences[k + 1].id : null,
          startSec: +(gs / SPEECH_SR).toFixed(4), endSec: +(ge / SPEECH_SR).toFixed(4),
          durationSec: +((ge - gs) / SPEECH_SR).toFixed(4),
        });
      }
      C.add('speech present in every line (mp4)', minSpeech > 0.01, `lowest line RMS ${minSpeech.toFixed(4)}`);
      C.add('gaps are silent (mp4, 50 ms margins)', maxGapPeak < 0.005, `max gap peak ${maxGapPeak.toFixed(5)}`);
      const long = gaps.filter((g) => g.beforeSentence && g.durationSec > 2);
      const longOver5 = long.filter((g) => g.durationSec > 5);
      C.add('long pauses planted', long.length >= 4 && longOver5.length === 1 && Math.abs(longOver5[0].durationSec - 6) < 0.05,
        long.map((g) => `${g.durationSec}s after ${g.afterSentence}`).join(', '));
      const kinds = (k) => sentences.filter((s) => s.kind === k);
      const groups = [...new Set(sentences.filter((s) => s.retakeGroup).map((s) => s.retakeGroup))];
      C.add('planted events', groups.length >= 4 && kinds('false_start').length >= 3 && kinds('aside').length >= 2 &&
        sentences.some((s) => s.fillers.length),
        `${groups.length} retake groups, ${kinds('false_start').length} false starts, ${kinds('aside').length} asides, ${sentences.reduce((n, s) => n + s.fillers.length, 0)} fillers`);
      C.add('duration about two minutes', totalSec >= 100 && totalSec <= 150, `${totalSec.toFixed(2)} s`);
      const withWords = sentences.filter((s) => s.wordTimes).length;
      C.add('word start times', withWords >= sentences.length * 0.8, `${withWords}/${sentences.length} lines have word times`);
      const disordered = sentences.filter((s) => s.wordTimes && s.words.some((w, k) => k > 0 && w.startSec < s.words[k - 1].startSec)).map((s) => s.id);
      C.add('word start times ascend within each line', disordered.length === 0, disordered.length ? disordered.join(', ') : 'all lines');
      C.assertAll();

      renameSync(wavPartial, join(OUT, `${name}.wav`));
      rmSync(work, { recursive: true, force: true });

      desc.checks.push(...C.list);
      desc.extraFiles = {
        wav16k: {
          file: `${name}.wav`, path: rel(join(OUT, `${name}.wav`)), codec: 'pcm_s16le',
          sampleRate: 16000, channels: 1, bitsPerSample: 16, durationSec: totalSec,
          sizeBytes: statSync(join(OUT, `${name}.wav`)).size,
          note: 'The exact synthesised signal. The mp4 audio is the same signal resampled to 48 kHz stereo AAC.',
        },
      };
      desc.speech = {
        source: `Windows System.Speech, voice "${result.voice}", rate ${SPEECH_RATE}`,
        timeBase: 'seconds from the start of the file; identical in the mp4 and the wav',
        totalSec,
        leadInSec: LEAD_IN_SEC,
        sentences: sentences.map(({ startSample16k, endSample16k, ...rest }) => ({ ...rest, startSample16k, endSample16k })),
        gaps,
        longPauses: long,
        retakeGroups: groups.map((g) => {
          const ids = sentences.filter((s) => s.retakeGroup === g).map((s) => s.id);
          return { group: g, sentences: ids, keep: ids[ids.length - 1] };
        }),
        falseStarts: kinds('false_start').map((s) => s.id),
        asides: kinds('aside').map((s) => s.id),
        fullText: sentences.map((s) => s.text).join(' '),
        keptText: sentences.filter((s) => s.keep).map((s) => s.text).join(' '),
        expectedWords: sentences.flatMap((s) => s.words.map((w) => ({ sentence: s.id, ...w }))),
      };
      return desc;
    },
  };
}

// ---------------------------------------------------------------- registry

const FIXTURES = [
  numberedFixture({
    name: 'numbered-4k-h264', w: 3840, h: 2160, fps: 30,
    purpose: 'Numbered frames with a beep at every whole second, 30 s, 4K H.264 8-bit CFR. Export, proxy, player.',
    tracks: [{ channels: 2, freq: 1000 }],
  }),
  numberedFixture({
    name: 'numbered-4k-hevc10-hdr', w: 3840, h: 2160, fps: 30, video: 'hevc10-hdr',
    purpose: 'As numbered-4k-h264 in HEVC Main10 with HDR10 (PQ, BT.2020) signalling. Export keeps bit depth and HDR.',
    tracks: [{ channels: 2, freq: 1000 }],
  }),
  numberedFixture({
    name: 'numbered-vfr', w: 3840, h: 2160, vfr: true,
    purpose: 'Same content with genuinely variable frame timing (30, ~24, 60, 30-with-drops and 20 fps segments), 30 s wall clock. Conversion to CFR keeps time.',
    tracks: [{ channels: 2, freq: 1000 }],
  }),
  numberedFixture({
    name: 'numbered-3audio', w: 3840, h: 2160, fps: 30,
    purpose: 'As numbered-4k-h264 with three audio tracks, each with its own beep pitch and a title. All tracks kept; track choice.',
    tracks: [
      { channels: 2, freq: 1000, title: 'Main mix (1000 Hz)' },
      { channels: 1, freq: 500, title: 'Lav mic (500 Hz)' },
      { channels: 1, freq: 2000, title: 'Camera mic (2000 Hz)' },
    ],
  }),
  numberedFixture({
    name: 'numbered-1080p60', w: 1920, h: 1080, fps: 60,
    purpose: 'As numbered-4k-h264 at 1920x1080, 60 fps. Mixed sources follow the first clip.',
    tracks: [{ channels: 2, freq: 1000 }],
  }),
  numberedFixture({
    name: 'silence-only', w: 1920, h: 1080, fps: 30, dur: 20,
    purpose: '20 s of numbered picture with digital silence (all-zero stereo audio). "No speech" state.',
    tracks: [{ channels: 2, silent: true }],
  }),
  speechFixture(),
];

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const o = { only: [], force: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--list') o.list = true;
    else if (a === '--only') o.only.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a.startsWith('--only=')) o.only.push(...a.slice(7).split(',').filter(Boolean));
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function ffmpegVersion() {
  const r = await run('ffmpeg', ['-hide_banner', '-version']);
  return r.stdout.toString().split(/\r?\n/)[0];
}

function entryPath(name) { return join(OUT, `${name}.entry.json`); }

function writeManifest(ffv) {
  const fixtures = {};
  for (const f of FIXTURES) {
    const ep = entryPath(f.name);
    if (existsSync(ep) && existsSync(join(OUT, f.file))) fixtures[f.name] = JSON.parse(readFileSync(ep, 'utf8'));
  }
  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    ffmpeg: ffv,
    outDir: rel(OUT),
    pathsRelativeTo: 'project root',
    fixtures,
  };
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.list) {
    console.log(FIXTURES.map((f) => `${f.name.padEnd(24)} ${f.purpose}`).join('\n'));
    if (opts.help) console.log('\nusage: node fixtures/generate.mjs [--only <name>[,<name>]] [--force] [--list]');
    return;
  }
  for (const n of opts.only) {
    if (!FIXTURES.some((f) => f.name === n)) throw new Error(`unknown fixture "${n}"; known: ${FIXTURES.map((f) => f.name).join(', ')}`);
  }
  mkdirSync(TMP, { recursive: true });
  const ffv = await ffmpegVersion();
  log(ffv);
  const todo = FIXTURES.filter((f) => !opts.only.length || opts.only.includes(f.name));
  for (const f of todo) {
    const final = join(OUT, f.file);
    const done = existsSync(final) && existsSync(entryPath(f.name)) && (f.extraFiles || []).every((x) => existsSync(join(OUT, x)));
    if (done && !opts.force) { log(`${f.name}: exists, skipped (use --force to rebuild)`); continue; }
    log(`${f.name}: building`);
    const t0 = Date.now();
    const partial = join(OUT, `${f.name}.partial.mp4`);
    rmSync(partial, { force: true });
    rmSync(entryPath(f.name), { force: true });
    try {
      const desc = await f.build(final, partial);
      rmSync(final, { force: true });
      renameSync(partial, final);
      const entry = {
        name: f.name, file: f.file, path: rel(final), purpose: f.purpose,
        ...desc, sizeBytes: statSync(final).size, generatedAt: new Date().toISOString(),
        buildSeconds: +((Date.now() - t0) / 1000).toFixed(1),
      };
      writeFileSync(entryPath(f.name), JSON.stringify(entry, null, 2));
      log(`${f.name}: done in ${entry.buildSeconds} s`);
    } catch (e) {
      rmSync(partial, { force: true });
      rmSync(join(OUT, `${f.name}.partial.wav`), { force: true });
      writeManifest(ffv);
      throw e;
    }
  }
  const m = writeManifest(ffv);
  try { if (readdirSync(TMP).length === 0) rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  const missing = FIXTURES.filter((f) => !m.fixtures[f.name]).map((f) => f.name);
  log(`manifest: ${rel(join(OUT, 'manifest.json'))} (${Object.keys(m.fixtures).length} fixtures${missing.length ? `; not built: ${missing.join(', ')}` : ''})`);
}

main().catch((e) => {
  console.error(`[fixtures] FAILED: ${e.message}`);
  process.exit(1);
});
