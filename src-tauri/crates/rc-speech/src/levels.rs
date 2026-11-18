//! The sound level of the audio fed to the transcriber, in 10 ms windows.
//!
//! The transcript builder uses it to pull word ends back out of a following pause and to
//! find the quietest point of each gap (spec 2.4.5). It is filled from exactly the PCM that
//! is written to the transcriber, so both see the same signal.

use rc_types::Micros;

/// Sample rate of the transcriber's input.
pub const SAMPLE_RATE: u32 = 16_000;
/// Length of one level window.
pub const WINDOW_MICROS: Micros = 10_000;
const WINDOW_SAMPLES: usize = (SAMPLE_RATE as usize) / 100;
/// The level given to digital silence (and the lowest level stored).
pub const SILENCE_DB: f32 = -100.0;
/// Below this a noise floor is treated as silence: thresholds are never set lower than this.
const FLOOR_LIMIT_DB: f32 = -70.0;

/// Shortest silence inside a word's recorded span that counts as the gap before the next
/// word (100 ms: longer than the closure of a stop consonant).
const INNER_GAP_WINDOWS: usize = 10;

/// Windows between two stored histogram checkpoints (one second).
const CHECKPOINT_WINDOWS: usize = 100;
const BINS: usize = 101;

/// Per-window loudness (RMS, dBFS) of 16 kHz mono s16le audio, built incrementally.
///
/// A track is *live* while audio is still being added and *ended* once all of it is in
/// ([`mark_ended`](Self::mark_ended), or a track made with [`from_levels`](Self::from_levels)).
/// Every measurement at time `t` uses only the windows before `t`, so a word measured while
/// streaming gets exactly the result it would get from the finished track.
#[derive(Debug, Clone, Default)]
pub struct LevelTrack {
    levels: Vec<f32>,
    sum_sq: f64,
    count: usize,
    odd_byte: Option<u8>,
    /// Histogram of window levels in whole dB, index 0 = -100 dB, 100 = 0 dB.
    hist: Vec<u32>,
    /// `checkpoints[k]` is the histogram of windows `[0, k * CHECKPOINT_WINDOWS)`.
    checkpoints: Vec<Vec<u32>>,
    ended: bool,
}

impl LevelTrack {
    /// An empty, live track.
    pub fn new() -> Self {
        LevelTrack { hist: vec![0; BINS], checkpoints: vec![vec![0; BINS]], ..Default::default() }
    }

    /// An ended track made from precomputed window levels (dBFS, one per 10 ms). With no
    /// levels at all it stands for "no sound information": nothing is tightened.
    pub fn from_levels(levels: impl IntoIterator<Item = f32>) -> Self {
        let mut t = LevelTrack::new();
        for l in levels {
            t.push_level(l.clamp(SILENCE_DB, 0.0));
        }
        t.ended = true;
        t
    }

    /// An ended track of the whole of `pcm` (16 kHz mono s16le).
    pub fn from_pcm(pcm: &[u8]) -> Self {
        let mut t = LevelTrack::new();
        t.push_pcm(pcm);
        t.mark_ended();
        t
    }

    /// Records that no more audio will be added.
    pub fn mark_ended(&mut self) {
        self.ended = true;
    }

    /// True once no more audio will be added.
    pub fn is_ended(&self) -> bool {
        self.ended
    }

    /// True when everything up to `t` is known, or nothing more will ever be.
    pub fn covers(&self, t: Micros) -> bool {
        self.ended || self.covered_until() >= t
    }

    /// Adds raw PCM bytes (signed 16-bit little-endian, mono, 16 kHz). Chunks may split samples.
    pub fn push_pcm(&mut self, mut bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if let Some(lo) = self.odd_byte.take() {
            self.push_sample(i16::from_le_bytes([lo, bytes[0]]));
            bytes = &bytes[1..];
        }
        let (pairs, rest) = bytes.as_chunks::<2>();
        for c in pairs {
            self.push_sample(i16::from_le_bytes(*c));
        }
        if let [last] = rest {
            self.odd_byte = Some(*last);
        }
    }

    fn push_sample(&mut self, s: i16) {
        let v = f64::from(s);
        self.sum_sq += v * v;
        self.count += 1;
        if self.count == WINDOW_SAMPLES {
            let rms = (self.sum_sq / WINDOW_SAMPLES as f64).sqrt();
            let db = if rms <= 0.0 { SILENCE_DB } else { (20.0 * (rms / 32768.0).log10()) as f32 };
            self.push_level(db.clamp(SILENCE_DB, 0.0));
            self.sum_sq = 0.0;
            self.count = 0;
        }
    }

    fn push_level(&mut self, db: f32) {
        if self.hist.len() != BINS {
            self.hist = vec![0; BINS];
            self.checkpoints = vec![vec![0; BINS]];
        }
        self.hist[bin_of(db)] += 1;
        self.levels.push(db);
        if self.levels.len().is_multiple_of(CHECKPOINT_WINDOWS) {
            self.checkpoints.push(self.hist.clone());
        }
    }

    /// Number of complete windows.
    pub fn len(&self) -> usize {
        self.levels.len()
    }

    /// True when no complete window exists yet.
    pub fn is_empty(&self) -> bool {
        self.levels.is_empty()
    }

    /// The time up to which levels are known.
    pub fn covered_until(&self) -> Micros {
        self.levels.len() as Micros * WINDOW_MICROS
    }

    /// The level of window `i` (covering `[i*10ms, (i+1)*10ms)`).
    pub fn level(&self, i: usize) -> Option<f32> {
        self.levels.get(i).copied()
    }

    /// The background level before `t`: the 10th percentile of the windows that end at or
    /// before `t`, never below -70 dBFS (-70 when there are none).
    pub fn noise_floor_before(&self, t: Micros) -> f32 {
        let n = ((t.max(0) / WINDOW_MICROS) as usize).min(self.levels.len());
        let k = n / CHECKPOINT_WINDOWS;
        let Some(base) = self.checkpoints.get(k) else { return FLOOR_LIMIT_DB };
        let mut hist = base.clone();
        for &db in &self.levels[k * CHECKPOINT_WINDOWS..n] {
            hist[bin_of(db)] += 1;
        }
        let total: u64 = hist.iter().map(|&c| u64::from(c)).sum();
        if total == 0 {
            return FLOOR_LIMIT_DB;
        }
        let target = (total as f64 * 0.10).ceil().max(1.0) as u64;
        let mut seen = 0u64;
        for (bin, c) in hist.iter().enumerate() {
            seen += u64::from(*c);
            if seen >= target {
                return (SILENCE_DB + bin as f32).max(FLOOR_LIMIT_DB);
            }
        }
        FLOOR_LIMIT_DB
    }

    /// Indices of the windows that lie entirely inside `[a, b)` and are known.
    fn windows_within(&self, a: Micros, b: Micros) -> std::ops::Range<usize> {
        let first = ((a.max(0) + WINDOW_MICROS - 1) / WINDOW_MICROS) as usize;
        let last = ((b.max(0) / WINDOW_MICROS) as usize).min(self.levels.len());
        first..last.max(first)
    }

    /// Pulls a word's end back to where its sound actually stops, if it ran on into quiet.
    ///
    /// Scans from `end` backwards for the last window that is clearly above the background,
    /// relative to the word's own loudest window. When the next word's onset already sits
    /// inside `end` (sound runs on to `end` after a true silence of 100 ms or more inside the
    /// word), the word ends where that silence starts. Returns `end` unchanged when the levels do
    /// not cover the word, when the word is not clearly louder than the background, or when
    /// less than `min_trim` would be removed.
    pub fn tighten_end(&self, start: Micros, end: Micros, hangover: Micros, min_trim: Micros, min_len: Micros) -> Micros {
        if end <= start || self.covered_until() < end {
            return end;
        }
        let idx = self.windows_within(start, end);
        if idx.is_empty() {
            return end;
        }
        let peak = self.levels[idx.clone()].iter().copied().fold(SILENCE_DB, f32::max);
        let floor = self.noise_floor_before(end);
        if peak - floor < 10.0 {
            return end;
        }
        let threshold = floor + ((peak - floor) * 0.3).clamp(6.0, 20.0);
        let Some(last_loud) = idx.clone().rev().find(|&i| self.levels[i] >= threshold) else {
            return end;
        };
        // The model's word times touch, so the next word's onset often sits inside this
        // word's recorded end. A true silence inside the word, followed by sound that runs
        // on to the recorded end, is the gap between the two words: the word ends there.
        let sound_end_window = self.silence_before_run_on(idx.clone(), floor, threshold).unwrap_or(last_loud + 1);
        let sound_end = sound_end_window as Micros * WINDOW_MICROS + hangover;
        let new_end = sound_end.max(start + min_len);
        if end - new_end >= min_trim { new_end } else { end }
    }

    /// The loudest level (dBFS) of the windows that lie entirely inside `[a, b)`. `None` when
    /// the levels do not reach `b` or no whole window fits. Reads nothing outside `[a, b)`.
    pub fn peak_level(&self, a: Micros, b: Micros) -> Option<f32> {
        if b <= a || self.covered_until() < b {
            return None;
        }
        let idx = self.windows_within(a, b);
        if idx.is_empty() {
            return None;
        }
        Some(self.levels[idx].iter().copied().fold(SILENCE_DB, f32::max))
    }

    /// Inside the windows `idx` of one word: the first window of the first true silence
    /// (at least [`INNER_GAP_WINDOWS`] windows within 10 dB of the background `floor`) that
    /// comes after the word's first loud window and is followed by sound (at or above
    /// `threshold`) running on to the last window or the one before it. `None` when there is
    /// no such silence.
    fn silence_before_run_on(&self, idx: std::ops::Range<usize>, floor: f32, threshold: f32) -> Option<usize> {
        let lv = &self.levels;
        let last = idx.end.checked_sub(1)?;
        // The word's sound must run on to its recorded end (the next word's onset).
        if !(lv[last] >= threshold || (last > idx.start && lv[last - 1] >= threshold)) {
            return None;
        }
        let first_loud = idx.clone().find(|&i| lv[i] >= threshold)?;
        let quiet = floor + 10.0;
        let mut run_start = None;
        for i in first_loud..=last {
            if lv[i] <= quiet {
                let s = *run_start.get_or_insert(i);
                if i + 1 - s >= INNER_GAP_WINDOWS {
                    // Sound after the silence must be continuous to the end: nothing more
                    // than short dips below the threshold.
                    let tail_start = (i + 1..=last).find(|&k| lv[k] >= threshold)?;
                    let tail_quiet = (tail_start..=last).filter(|&k| lv[k] <= quiet).count();
                    return (tail_quiet == 0).then_some(s);
                }
            } else {
                run_start = None;
            }
        }
        None
    }

    /// Where the sound that runs up to `b` starts, looking back no further than `a` and
    /// `max_back`: the first window of the run of windows clearly above the background
    /// (10 dB) that ends at `b`, minus `hangover`. Returns `b` when there is no such run or
    /// the levels do not cover `b`. Used to keep a pause chip clear of sound the speech
    /// detector did not count as speech (a soft "uh" before the first word).
    pub fn sound_onset_before(&self, a: Micros, b: Micros, hangover: Micros, max_back: Micros) -> Micros {
        if b <= a || self.covered_until() < b {
            return b;
        }
        let lo = a.max(b - max_back);
        let idx = self.windows_within(lo, b);
        if idx.is_empty() {
            return b;
        }
        let threshold = self.noise_floor_before(lo) + 10.0;
        let mut first_loud = None;
        for i in idx.rev() {
            if self.levels[i] >= threshold {
                first_loud = Some(i);
            } else {
                break;
            }
        }
        match first_loud {
            Some(i) => (i as Micros * WINDOW_MICROS - hangover).clamp(a, b),
            None => b,
        }
    }

    /// The mean level (dBFS) of the windows that lie entirely inside `[a, b)`. `None` when
    /// the levels do not reach `b` or no whole window fits. Reads nothing outside `[a, b)`.
    pub fn mean_level(&self, a: Micros, b: Micros) -> Option<f32> {
        if b <= a || self.covered_until() < b {
            return None;
        }
        let idx = self.windows_within(a, b);
        if idx.is_empty() {
            return None;
        }
        let n = idx.len() as f32;
        Some(self.levels[idx].iter().sum::<f32>() / n)
    }

    /// The quietest point of `[a, b]`: the middle of the longest run of windows within 1.5 dB
    /// of the quietest (after 30 ms smoothing). The midpoint of the range when the levels do
    /// not cover it.
    pub fn quietest_point(&self, a: Micros, b: Micros) -> Micros {
        if b <= a {
            return b;
        }
        let mid = a + (b - a) / 2;
        if self.covered_until() < b {
            return mid;
        }
        let idx = self.windows_within(a, b);
        if idx.is_empty() {
            return mid;
        }
        let smooth: Vec<f32> = idx
            .clone()
            .map(|i| {
                let lo = i.saturating_sub(1).max(idx.start);
                let hi = (i + 1).min(idx.end - 1);
                let s: f32 = self.levels[lo..=hi].iter().sum();
                s / (hi - lo + 1) as f32
            })
            .collect();
        let min = smooth.iter().copied().fold(f32::INFINITY, f32::min);
        let (mut best_start, mut best_len) = (0usize, 0usize);
        let mut run_start = None;
        for (k, v) in smooth.iter().enumerate().chain(std::iter::once((smooth.len(), &f32::INFINITY))) {
            let quiet = *v <= min + 1.5;
            match (quiet, run_start) {
                (true, None) => run_start = Some(k),
                (false, Some(s)) => {
                    if k - s > best_len {
                        best_start = s;
                        best_len = k - s;
                    }
                    run_start = None;
                }
                _ => {}
            }
        }
        // Centre of the run, in time.
        let first_win = idx.start + best_start;
        let run_a = first_win as Micros * WINDOW_MICROS;
        let run_b = (first_win + best_len) as Micros * WINDOW_MICROS;
        (run_a + (run_b - run_a) / 2).clamp(a, b)
    }
}

/// Histogram bin of a level: whole dB above -100.
fn bin_of(db: f32) -> usize {
    (db - SILENCE_DB).round().clamp(0.0, (BINS - 1) as f32) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: impl IntoIterator<Item = i16>) -> Vec<u8> {
        samples.into_iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    /// `ms` milliseconds of a 440 Hz tone at `amp` (0..1), or silence when amp is 0.
    fn tone(ms: usize, amp: f64) -> Vec<i16> {
        (0..ms * 16).map(|n| (amp * 32767.0 * (n as f64 * 440.0 * std::f64::consts::TAU / 16000.0).sin()) as i16).collect()
    }

    #[test]
    fn measures_windows_even_when_chunks_split_samples() {
        let mut all = tone(100, 0.5);
        all.extend(tone(100, 0.0));
        let bytes = pcm(all);
        let mut whole = LevelTrack::new();
        whole.push_pcm(&bytes);
        let mut split = LevelTrack::new();
        for c in bytes.chunks(7) {
            split.push_pcm(c);
        }
        assert_eq!(whole.len(), 20);
        assert_eq!(whole.levels, split.levels);
        // A half-scale sine has an RMS of about -9 dBFS.
        assert!((whole.level(5).unwrap() + 9.0).abs() < 0.5, "{:?}", whole.level(5));
        assert_eq!(whole.level(15), Some(SILENCE_DB));
        assert_eq!(whole.covered_until(), 200_000);
    }

    #[test]
    fn tightens_an_end_that_runs_into_silence() {
        let mut s = tone(500, 0.3);
        s.extend(tone(1000, 0.0));
        let mut t = LevelTrack::new();
        t.push_pcm(&pcm(s));
        // The word claims 0..800 ms; sound stops at 500 ms.
        let e = t.tighten_end(0, 800_000, 40_000, 60_000, 20_000);
        assert_eq!(e, 540_000);
        // Not covered: unchanged.
        assert_eq!(t.tighten_end(0, 2_000_000, 40_000, 60_000, 20_000), 2_000_000);
        // Small trims are not worth it.
        assert_eq!(t.tighten_end(0, 560_000, 40_000, 60_000, 20_000), 560_000);
    }

    #[test]
    fn measurements_use_only_the_past_and_coverage_is_tracked() {
        // 3 s of quiet noise, then 3 s of loud tone.
        let mut s = tone(3000, 0.001);
        s.extend(tone(3000, 0.5));
        let bytes = pcm(s);
        let whole = LevelTrack::from_pcm(&bytes);
        let mut live = LevelTrack::new();
        live.push_pcm(&bytes[..bytes.len() / 2]);
        // The floor before 2.5 s is the same however much audio came after.
        assert_eq!(live.noise_floor_before(2_500_000), whole.noise_floor_before(2_500_000));
        assert!(whole.noise_floor_before(2_500_000) < -60.0);
        assert!(whole.noise_floor_before(6_000_000) < -60.0, "the 10th percentile stays in the quiet part");
        assert!(live.covers(3_000_000) && !live.covers(3_000_001));
        live.mark_ended();
        assert!(live.covers(i64::MAX));
        assert!(LevelTrack::from_levels([]).covers(1));
        assert_eq!(LevelTrack::new().noise_floor_before(1_000_000), -70.0);
    }

    #[test]
    fn finds_where_the_sound_before_a_point_starts() {
        let mut s = tone(1000, 0.0);
        s.extend(tone(300, 0.2)); // 1.0 to 1.3 s
        let mut t = LevelTrack::new();
        t.push_pcm(&pcm(s));
        assert_eq!(t.sound_onset_before(0, 1_300_000, 40_000, 1_000_000), 960_000);
        // Quiet just before the point: nothing to move.
        assert_eq!(t.sound_onset_before(0, 900_000, 40_000, 1_000_000), 900_000);
        // Never earlier than `a`, never further back than `max_back`.
        assert_eq!(t.sound_onset_before(1_100_000, 1_300_000, 40_000, 1_000_000), 1_100_000);
        assert_eq!(t.sound_onset_before(0, 1_300_000, 40_000, 100_000), 1_200_000 - 40_000);
        // Not covered: unchanged.
        assert_eq!(t.sound_onset_before(0, 5_000_000, 40_000, 1_000_000), 5_000_000);
    }

    #[test]
    fn finds_the_middle_of_the_quiet_run() {
        let mut s = tone(300, 0.3);
        s.extend(tone(100, 0.01));
        s.extend(tone(200, 0.0));
        s.extend(tone(300, 0.3));
        let mut t = LevelTrack::new();
        t.push_pcm(&pcm(s));
        let q = t.quietest_point(250_000, 650_000);
        assert!((480_000..=520_000).contains(&q), "{q}");
        assert_eq!(t.quietest_point(5_000_000, 6_000_000), 5_500_000);
        assert_eq!(t.quietest_point(10, 10), 10);
    }

    #[test]
    fn mean_level_uses_only_whole_windows_inside_the_range() {
        let t = LevelTrack::from_levels([-100.0, -40.0, -10.0, -10.0]);
        assert_eq!(t.mean_level(0, 30_000), Some(-50.0));
        // Only windows 1 and 2 lie entirely inside 5..35 ms.
        assert_eq!(t.mean_level(5_000, 35_000), Some(-25.0));
        assert_eq!(t.mean_level(5_000, 15_000), None);
        assert_eq!(t.mean_level(0, 50_000), None, "not measured that far");
        assert_eq!(LevelTrack::from_levels([]).mean_level(0, 10_000), None);
        assert_eq!(t.peak_level(0, 20_000), Some(-40.0));
        assert_eq!(t.peak_level(0, 50_000), None);
    }
}
