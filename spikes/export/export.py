"""Clip-by-clip export (spec 2.4.8), ffmpeg command lines only.

A clip is (source_path, start_frame, n_frames) on the sequence frame grid (fps).  In the app the
clip edges are whole microseconds already snapped to that grid; frame = round(us * fps / 1e6).

Steps
  1. piece_cmd: GPU decode from the original, seek, cut to exactly n frames, NVENC encode.
  2. audio: one ffmpeg run renders every audio track for the whole sequence, with ramps
     (audio_script + audio_script_cmd; audio_cmd is the per-input form, limited to about 50 clips).
  3. join: concat demuxer joins the pieces without re-encoding, muxes the audio (encoded to AAC).
"""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

from common import FFMPEG, probe, run

RAMP = Fraction(4, 1000)  # seconds of fade at each side of every cut
AUDIO_RATE = 48000


def fmt_t(x):
    """Seconds as a decimal string with microsecond precision."""
    return f"{float(x):.6f}"


def video_settings(codec, cq=19, preset="p4", gop=60, ten_bit=False):
    """NVENC constant-quality settings. Identical for every piece of one export."""
    # B-frames used as references ("-b_ref_mode middle") are off for H.264: full-length H.264
    # encodes made with it decoded differently in libavcodec and NVDEC (16 to 55 frames, PSNR down
    # to 16 dB between the two decoders, once with "Reference 3 >= 3"); see decode_check.py.
    bref = "disabled" if codec == "h264" else "middle"
    common = ["-preset", preset, "-tune", "hq", "-rc", "vbr", "-cq", str(cq), "-b:v", "0",
              "-bf", "3", "-b_ref_mode", bref, "-spatial-aq", "1", "-temporal-aq", "1",
              "-rc-lookahead", "32", "-g", str(gop)]
    # Without an explicit -maxrate, NVENC's VBR caps the rate on its own (measured: about 128 Mbps
    # for grainy 4K H.264 at cq 16, where constqp 16 needs 261 Mbps), so cq stops governing
    # quality on hard scenes. Set the ceiling to the level limit instead.
    if codec == "h264":   # High@5.1: MaxBR 300 Mbps, CPB 300 Mbit
        return ["-c:v", "h264_nvenc", *common, "-maxrate", "240M", "-bufsize", "300M",
                "-profile:v", "high"]
    # HEVC High tier @5.1: MaxBR 160 Mbps, CPB 160 Mbit
    return ["-c:v", "hevc_nvenc", *common, "-maxrate", "160M", "-bufsize", "160M",
            "-profile:v", "main10" if ten_bit else "main", "-tier", "high", "-tag:v", "hvc1"]


def timescale(fps):
    fps = Fraction(fps)
    # 30 -> 15360 (512 ticks/frame), 30000/1001 -> 30000, 25 -> 12800, 60 -> 15360
    if fps.denominator == 1:
        return 512 * fps.numerator if 512 * fps.numerator <= 65535 else 90000
    return fps.numerator


def piece_cmd(src, start, n, fps, vset, out, preroll=1.0):
    fps = Fraction(fps)
    seek = max(0.0, float(start / fps) - preroll)
    # After the fps filter the time base is 1/fps, so a frame's pts IS its slot on the frame grid
    # (timestamps are absolute because of -copyts). trim on pts slots is exact; trim=start/end in
    # seconds is not: 'end' also drops the frame whose display interval crosses it (loses the last
    # frame of every clip).
    vf = (f"fps={fps.numerator}/{fps.denominator},"
          f"trim=start_pts={start}:end_pts={start + n},setpts=PTS-STARTPTS")
    return [FFMPEG, "-hide_banner", "-nostdin", "-y", "-v", "error",
            "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
            "-noaccurate_seek", "-ss", fmt_t(seek), "-copyts", "-i", src,
            "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", vf, "-frames:v", str(n),
            "-fps_mode", "passthrough", *vset,
            "-video_track_timescale", str(timescale(fps)), "-movie_timescale", str(timescale(fps)),
            "-map_metadata", "-1", out]


def sample_edges(clips, fps):
    """Output sample index where each clip starts, plus the total. Derived from the cumulative frame
    count (floor(frames * rate / fps)), so audio length always equals video length to the sample,
    also at 30000/1001 where a frame is not a whole number of samples."""
    fps = Fraction(fps)
    edges, cum = [0], 0
    for _, _, n in clips:
        cum += n
        edges.append(cum * AUDIO_RATE * fps.denominator // fps.numerator)
    return edges


def audio_cmd(clips, fps, n_tracks, out, layouts):
    """Per-input form of the audio render (one -i per clip); kept for comparison only.
    clips: list of (src, start_frame, n_frames). layouts: channel layout per output track."""
    fps = Fraction(fps)
    edges = sample_edges(clips, fps)
    args = [FFMPEG, "-hide_banner", "-nostdin", "-y", "-v", "error"]
    for src, start, n in clips:
        args += ["-vn", "-sn", "-dn", "-ss", fmt_t(Fraction(start) / fps), "-i", src]
    chains, labels = [], []
    for i, (src, start, n) in enumerate(clips):
        samples = edges[i + 1] - edges[i]
        dur = Fraction(samples, AUDIO_RATE)
        for t in range(n_tracks):
            chains.append(
                f"[{i}:a:{t}]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts={layouts[t]},"
                f"atrim=end_sample={samples},apad=whole_len={samples},asetpts=PTS-STARTPTS,"
                f"afade=t=in:d={fmt_t(RAMP)},afade=t=out:st={fmt_t(dur - RAMP)}:d={fmt_t(RAMP)}"
                f"[c{i}t{t}]")
            labels.append(f"[c{i}t{t}]")
    outs = "".join(f"[o{t}]" for t in range(n_tracks))
    graph = ";".join(chains) + ";" + "".join(labels) +         f"concat=n={len(clips)}:v=0:a={n_tracks}{outs}"
    args += ["-filter_complex", graph]
    for t in range(n_tracks):
        args += ["-map", f"[o{t}]"]
    args += ["-c:a", "pcm_f32le", "-f", "nut", out]
    return args


def filter_path(p):
    """A path as a quoted filter option value: forward slashes, ':' escaped, inside '...'."""
    p = os.path.abspath(p).replace("\\", "/").replace(":", "\\:").replace("'", "'\\''")
    return f"'{p}'"


def audio_script(clips, fps, layouts):
    """The audio filter graph for the whole sequence, as script text (one amovie per clip), for
    audio_script_cmd. Nothing in it grows the command line, so it works for any clip count."""
    fps = Fraction(fps)
    edges = sample_edges(clips, fps)
    n_tracks = len(layouts)
    streams = "+".join(f"a\\\\:{t}" for t in range(n_tracks))
    lines, labels = [], []
    for i, (src, start, n) in enumerate(clips):
        samples = edges[i + 1] - edges[i]
        a0 = Fraction(start) / fps * AUDIO_RATE          # first source sample of the clip
        a0 = a0.numerator // a0.denominator
        dur = Fraction(samples, AUDIO_RATE)
        seek = max(0.0, float(Fraction(start) / fps) - 1.0)  # land before the clip; atrim cuts exactly
        outs = "".join(f"[m{i}t{t}]" for t in range(n_tracks))
        lines.append(f"amovie=filename={filter_path(src)}:seek_point={seek:.6f}:streams={streams}{outs}")
        for t in range(n_tracks):
            lines.append(
                f"[m{i}t{t}]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts={layouts[t]},"
                f"asettb=1/{AUDIO_RATE},atrim=start_pts={a0}:end_pts={a0 + samples},"
                f"apad=whole_len={samples},asetpts=PTS-STARTPTS,"
                f"afade=t=in:d={fmt_t(RAMP)},afade=t=out:st={fmt_t(dur - RAMP)}:d={fmt_t(RAMP)}"
                f"[c{i}t{t}]")
            labels.append(f"[c{i}t{t}]")
    outs = "".join(f"[o{t}]" for t in range(n_tracks))
    lines.append("".join(labels) + f"concat=n={len(clips)}:v=0:a={n_tracks}{outs}")
    return ";\n".join(lines) + "\n"


def audio_script_cmd(script, n_tracks, out):
    """Render the audio graph in `script` (ffmpeg 7+: '-/option file' reads the value from a file)."""
    args = [FFMPEG, "-hide_banner", "-nostdin", "-y", "-v", "error", "-/filter_complex", script]
    for t in range(n_tracks):
        args += ["-map", f"[o{t}]"]
    return args + ["-c:a", "pcm_f32le", "-f", "nut", out]


def join_cmd(list_file, audio, out, codec, fps, n_tracks, abitrate="256k"):
    args = [FFMPEG, "-hide_banner", "-nostdin", "-y", "-v", "error",
            "-f", "concat", "-safe", "0", "-i", list_file, "-i", audio,
            "-map", "0:v:0"]
    for t in range(n_tracks):
        args += ["-map", f"1:a:{t}"]
    args += ["-c:v", "copy"]
    if codec == "hevc":
        args += ["-tag:v", "hvc1"]
    args += ["-c:a", "aac", "-b:a", abitrate, "-ar", str(AUDIO_RATE),
             "-video_track_timescale", str(timescale(fps)), "-movie_timescale", str(timescale(fps)),
             "-map_metadata", "-1", "-movflags", "+faststart", out]
    return args


def export(clips, out, fps, codec, cq, work, parallel=1, preset="p4", gop=60, ten_bit=None,
           keep=False, durations_in_list=True):
    """Run the whole export. Returns dict of timings."""
    os.makedirs(work, exist_ok=True)
    info = probe(clips[0][0])
    vstream = next(s for s in info["streams"] if s["codec_type"] == "video")
    if ten_bit is None:
        ten_bit = "10" in vstream.get("pix_fmt", "")
    astreams = [s for s in info["streams"] if s["codec_type"] == "audio"]
    layouts = [s.get("channel_layout") or ("stereo" if s["channels"] == 2 else "mono")
               for s in astreams]
    vset = video_settings(codec, cq, preset, gop, ten_bit)
    pieces = [os.path.join(work, f"piece_{i:04d}.mp4") for i in range(len(clips))]
    t = {"clips": len(clips), "frames": sum(c[2] for c in clips)}
    t0 = time.perf_counter()

    def enc(i):
        src, start, n = clips[i]
        dt, _ = run(piece_cmd(src, start, n, fps, vset, pieces[i]), label=f"piece {i}")
        return dt
    with ThreadPoolExecutor(max_workers=parallel) as ex:
        t["piece_times"] = list(ex.map(enc, range(len(clips))))
    t["video_s"] = time.perf_counter() - t0
    audio = os.path.join(work, "audio.nut")
    # Script form: the per-input form (audio_cmd) passes Windows' 32,767-character command-line
    # limit at about 50 clips (WinError 206, seen at 60 clips).
    script = os.path.join(work, "audio.filtergraph.txt")
    with open(script, "w", encoding="utf-8", newline="\n") as f:
        f.write(audio_script(clips, fps, layouts))
    t["audio_s"], _ = run(audio_script_cmd(script, len(astreams), audio), label="audio")
    lst = os.path.join(work, "pieces.txt")
    with open(lst, "w", encoding="utf-8") as f:
        for p, (_, _, n) in zip(pieces, clips):
            f.write(f"file '{p.replace(os.sep, '/')}'\n")
            if durations_in_list:   # exact piece length; never trust the container's rounding
                f.write(f"duration {fmt_t(Fraction(n) / Fraction(fps))}\n")
    tmp = out + ".partial.mp4"
    t["join_s"], _ = run(join_cmd(lst, audio, tmp, codec, fps, len(astreams)), label="join")
    os.replace(tmp, out)
    t["total_s"] = time.perf_counter() - t0
    t["out_seconds"] = float(Fraction(t["frames"]) / Fraction(fps))
    t["bytes"] = os.path.getsize(out)
    if not keep:
        for p in pieces + [audio, lst, script]:
            try:
                os.remove(p)
            except OSError:
                pass
    return t
