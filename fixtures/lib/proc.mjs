// Small process and WAV helpers shared by generate.mjs and verify.mjs.
// Node built-ins only. ffmpeg / ffprobe must be on PATH.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Run a program and collect its output.
 * @returns {Promise<{code:number, stdout:Buffer, stderr:string}>}
 */
export function run(cmd, args, { input, cwd, allowFail = false, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      if (onStderr) onStderr(s);
    });
    child.on('error', (e) => reject(new Error(`could not start ${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      const res = { code, stdout: Buffer.concat(out), stderr: err };
      if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} exited with ${code}\n  args: ${args.join(' ')}\n  stderr (tail): ${err.slice(-3000)}`));
      } else resolve(res);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function ffprobeJson(file, extraArgs = []) {
  const r = await run('ffprobe', ['-v', 'error', '-of', 'json', ...extraArgs, file]);
  return JSON.parse(r.stdout.toString('utf8'));
}

/** Write a 16-bit PCM WAV. `samples` is Int16Array, interleaved when channels > 1. */
export function writeWav16(path, samples, sampleRate, channels) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataBytes).copy(buf, 44);
  writeFileSync(path, buf);
}

/** Read a 16-bit PCM WAV. Returns {sampleRate, channels, samples: Int16Array (interleaved)}. */
export function readWav16(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${path}: data chunk before fmt chunk`);
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${path}: expected 16-bit PCM, got format ${fmt.format} / ${fmt.bits} bit`);
      size = Math.min(size, buf.length - body);
      const copy = Buffer.from(buf.subarray(body, body + (size & ~1)));
      const samples = new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}
