//! Raw PCM input and the bounded window of recent audio kept for cutting padded segments.

/// Sample rate of the input and of the models.
pub const SAMPLE_RATE: u32 = 16_000;

/// Whole microseconds at the start of sample `n` (exact: one sample is 62.5 µs, floored).
pub fn samples_to_micros(n: u64) -> u64 {
    n * 125 / 2
}

/// Turns a byte stream of signed 16-bit little-endian samples into floats in [-1, 1).
/// A sample split across two reads is joined; an odd final byte is dropped.
#[derive(Default)]
pub struct PcmDecoder {
    carry: Option<u8>,
}

impl PcmDecoder {
    /// Decodes `bytes`, appending whole samples to `out`.
    pub fn push(&mut self, mut bytes: &[u8], out: &mut Vec<f32>) {
        if bytes.is_empty() {
            return;
        }
        if let Some(lo) = self.carry.take() {
            out.push(f32::from(i16::from_le_bytes([lo, bytes[0]])) / 32768.0);
            bytes = &bytes[1..];
        }
        let mut pairs = bytes.chunks_exact(2);
        out.extend(pairs.by_ref().map(|c| f32::from(i16::from_le_bytes([c[0], c[1]])) / 32768.0));
        if let [last] = pairs.remainder() {
            self.carry = Some(*last);
        }
    }

    /// True when half a sample is waiting for its second byte.
    pub fn has_partial_sample(&self) -> bool {
        self.carry.is_some()
    }
}

/// The most recent audio, addressed by absolute sample index. Older audio is discarded on
/// request, so memory stays bounded however long the input is.
#[derive(Default)]
pub struct AudioWindow {
    origin: u64,
    samples: Vec<f32>,
}

impl AudioWindow {
    /// Appends samples at the end.
    pub fn extend(&mut self, s: &[f32]) {
        self.samples.extend_from_slice(s);
    }

    /// Absolute index of the first sample still held.
    pub fn origin(&self) -> u64 {
        self.origin
    }

    /// Absolute index one past the last sample received.
    pub fn end(&self) -> u64 {
        self.origin + self.samples.len() as u64
    }

    /// Samples `[start, end)`, clamped to what is held.
    pub fn slice(&self, start: u64, end: u64) -> &[f32] {
        let s = start.clamp(self.origin, self.end());
        let e = end.clamp(s, self.end());
        &self.samples[(s - self.origin) as usize..(e - self.origin) as usize]
    }

    /// Forgets every sample before absolute index `keep_from`. Compacts only when at least
    /// `min_drop` samples can go, so the copy cost stays small.
    pub fn discard_before(&mut self, keep_from: u64, min_drop: u64) {
        let keep_from = keep_from.min(self.end());
        if keep_from >= self.origin + min_drop {
            self.samples.drain(..(keep_from - self.origin) as usize);
            self.origin = keep_from;
        }
    }

    /// Number of samples held now.
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    /// True when nothing is held.
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn micros_are_exact_and_floored() {
        assert_eq!(samples_to_micros(0), 0);
        assert_eq!(samples_to_micros(1), 62);
        assert_eq!(samples_to_micros(2), 125);
        assert_eq!(samples_to_micros(16_000), 1_000_000);
        assert_eq!(samples_to_micros(16_000 * 3600 * 10), 36_000_000_000);
    }

    #[test]
    fn samples_split_across_reads_are_joined() {
        let all: Vec<u8> = [0i16, 1000, -32768, 32767, -1].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut whole = Vec::new();
        PcmDecoder::default().push(&all, &mut whole);
        for split in 0..all.len() {
            let mut d = PcmDecoder::default();
            let mut out = Vec::new();
            d.push(&all[..split], &mut out);
            d.push(&all[split..], &mut out);
            assert_eq!(out, whole, "split at {split}");
            assert!(!d.has_partial_sample());
        }
        assert_eq!(whole[2], -1.0);
        assert!((whole[1] - 1000.0 / 32768.0).abs() < 1e-9);
    }

    #[test]
    fn odd_trailing_byte_is_held_not_decoded() {
        let mut d = PcmDecoder::default();
        let mut out = Vec::new();
        d.push(&[1, 0, 7], &mut out);
        assert_eq!(out.len(), 1);
        assert!(d.has_partial_sample());
    }

    #[test]
    fn window_slices_by_absolute_index_and_discards() {
        let mut w = AudioWindow::default();
        w.extend(&(0..100).map(|i| i as f32).collect::<Vec<_>>());
        assert_eq!(w.slice(10, 13), &[10.0, 11.0, 12.0]);
        w.discard_before(50, 10);
        assert_eq!(w.origin(), 50);
        assert_eq!(w.len(), 50);
        assert_eq!(w.slice(40, 52), &[50.0, 51.0]);
        assert_eq!(w.slice(98, 200), &[98.0, 99.0]);
        w.discard_before(55, 10); // too little to bother
        assert_eq!(w.origin(), 50);
        assert_eq!(w.end(), 100);
        assert!(w.slice(120, 130).is_empty());
    }
}
