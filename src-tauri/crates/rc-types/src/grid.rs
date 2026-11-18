//! The frame grid (spec 2.4.2 "Frame grid", 3.4 rule 1): the one definition of how a frame
//! number becomes whole microseconds, shared by every module that snaps a time.
//!
//! `speech` (cut points), `project` (the first clip per source) and the interface's `edit`
//! and `transcript` (trims, selections) must agree to the microsecond, so they all use
//! these functions or their TypeScript twins in `src/types/grid.ts`. Both sides are checked
//! against the same vectors in `testdata/contract_vectors.json`.
//!
//! **Definition.** Frame `k` of a rate `num/den` frames per second starts at
//! `k * 1_000_000 * den / num` microseconds, rounded to the nearest whole microsecond,
//! halves rounded up:
//!
//! ```text
//! frame_to_micros(k) = floor((k * 1_000_000 * den + floor(num / 2)) / num)
//! ```
//!
//! A time is *on the grid* when it equals `frame_to_micros(k)` for some `k`. Every other
//! function here is defined in terms of those grid points, never by float arithmetic:
//! - [`micros_to_frame_floor`]: the last frame whose grid point is at or before `t`;
//! - [`floor_to_frame`] / [`ceil_to_frame`]: the grid point at or before / at or after `t`;
//! - [`snap_to_frame`]: the nearest grid point, ties going to the later one.
//!
//! All arithmetic is exact integer arithmetic (in `i128`). `rate.num` and `rate.den` must be
//! greater than zero; a zero `num` panics (division by zero).

use crate::basics::{Micros, Rational};

const MICROS_PER_SECOND: i128 = 1_000_000;

fn floor_div(a: i128, b: i128) -> i128 {
    // `b` is always positive here, so Euclidean division is floor division.
    a.div_euclid(b)
}

fn to_micros(v: i128) -> Micros {
    Micros::try_from(v).expect("frame grid time out of range for Micros")
}

/// Where frame `frame` starts, in whole microseconds (rounded half up).
pub fn frame_to_micros(frame: i64, rate: Rational) -> Micros {
    let num = i128::from(rate.num);
    let den = i128::from(rate.den);
    to_micros(floor_div(i128::from(frame) * MICROS_PER_SECOND * den + num / 2, num))
}

/// The last frame whose grid point is at or before `t`:
/// the largest `k` with `frame_to_micros(k, rate) <= t`.
pub fn micros_to_frame_floor(t: Micros, rate: Rational) -> i64 {
    let num = i128::from(rate.num);
    let den = i128::from(rate.den);
    // frame_to_micros(k) <= t  <=>  k*M*den + num/2 <= (t+1)*num - 1
    let k = floor_div((i128::from(t) + 1) * num - 1 - num / 2, MICROS_PER_SECOND * den);
    i64::try_from(k).expect("frame number out of range")
}

/// The grid point at or before `t`.
pub fn floor_to_frame(t: Micros, rate: Rational) -> Micros {
    frame_to_micros(micros_to_frame_floor(t, rate), rate)
}

/// The grid point at or after `t`.
pub fn ceil_to_frame(t: Micros, rate: Rational) -> Micros {
    let k = micros_to_frame_floor(t, rate);
    let at = frame_to_micros(k, rate);
    if at == t { at } else { frame_to_micros(k + 1, rate) }
}

/// The grid point nearest `t`; when `t` is exactly halfway, the later one.
pub fn snap_to_frame(t: Micros, rate: Rational) -> Micros {
    let k = micros_to_frame_floor(t, rate);
    let before = frame_to_micros(k, rate);
    let after = frame_to_micros(k + 1, rate);
    if t - before < after - t { before } else { after }
}

/// Whether `t` sits exactly on the grid.
pub fn is_on_frame_grid(t: Micros, rate: Rational) -> bool {
    floor_to_frame(t, rate) == t
}

/// The end of the one clip `create_project` makes for a source:
/// the source's duration floored to the sequence grid, so the clip `[0, end)` never runs past
/// the end of the file. `None` when the source is shorter than one frame of the grid
/// (such a source gets no clip, because a clip is never empty: spec 3.4 rule 1).
pub fn first_clip_end(duration: Micros, sequence_rate: Rational) -> Option<Micros> {
    let end = floor_to_frame(duration, sequence_rate);
    (end > 0).then_some(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NTSC: Rational = Rational { num: 30000, den: 1001 };

    #[test]
    fn grid_points_are_consistent_with_floor() {
        for rate in [NTSC, Rational { num: 24000, den: 1001 }, Rational { num: 25, den: 1 }, Rational { num: 60000, den: 1001 }] {
            for k in -5..5_000i64 {
                let t = frame_to_micros(k, rate);
                assert_eq!(micros_to_frame_floor(t, rate), k, "rate {rate:?} frame {k}");
                assert_eq!(micros_to_frame_floor(t - 1, rate), k - 1);
                assert!(is_on_frame_grid(t, rate));
                assert_eq!(snap_to_frame(t, rate), t);
                assert_eq!(ceil_to_frame(t - 1, rate), t);
                assert_eq!(floor_to_frame(t + 1, rate), t);
            }
        }
    }

    #[test]
    fn ntsc_frames_round_half_up() {
        assert_eq!(frame_to_micros(1, NTSC), 33_367); // 33366.67
        assert_eq!(frame_to_micros(2, NTSC), 66_733); // 66733.33
        assert_eq!(frame_to_micros(3, NTSC), 100_100);
        assert_eq!(first_clip_end(10, NTSC), None);
        assert_eq!(first_clip_end(66_732, NTSC), Some(33_367));
    }
}
