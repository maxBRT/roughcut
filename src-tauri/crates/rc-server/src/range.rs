//! Byte-range evaluation for `Range: bytes=...` (RFC 9110 section 14).
//!
//! Only one range per request is served. A header the server does not understand
//! (another unit, bad syntax, several ranges) is ignored and the whole file is sent,
//! which RFC 9110 allows. Browsers' media elements only ever send a single range.

/// What to send for a request, given its `Range` header and the file length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RangeOutcome {
    /// 200 with the whole file.
    Full,
    /// 206 with bytes `start..=end` (both inclusive, `end < len`).
    Partial { start: u64, end: u64 },
    /// 416 with `Content-Range: bytes */{len}`.
    Unsatisfiable,
}

/// Decides the response for `header` (the `Range` value, if any) on a file of `len` bytes.
pub(crate) fn evaluate(header: Option<&str>, len: u64) -> RangeOutcome {
    let Some(header) = header else {
        return RangeOutcome::Full;
    };
    let Some((unit, set)) = header.trim().split_once('=') else {
        return RangeOutcome::Full;
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return RangeOutcome::Full;
    }
    // RFC 9110 list syntax allows empty elements ("bytes=,0-1"); skip them.
    let specs: Vec<&str> = set.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    let [spec] = specs.as_slice() else {
        return RangeOutcome::Full;
    };
    let Some((first, last)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    let (first, last) = (first.trim(), last.trim());

    if first.is_empty() {
        // Suffix range: the last N bytes.
        let Some(n) = parse_digits(last) else {
            return RangeOutcome::Full;
        };
        if n == 0 || len == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        return RangeOutcome::Partial { start: len.saturating_sub(n), end: len - 1 };
    }

    let Some(start) = parse_digits(first) else {
        return RangeOutcome::Full;
    };
    let end = if last.is_empty() {
        None
    } else {
        match parse_digits(last) {
            Some(e) if e >= start => Some(e),
            // "5-3" or garbage: an invalid range-spec, so the header is ignored.
            _ => return RangeOutcome::Full,
        }
    };
    if start >= len {
        return RangeOutcome::Unsatisfiable;
    }
    let end = end.map_or(len - 1, |e| e.min(len - 1));
    RangeOutcome::Partial { start, end }
}

/// Parses a non-empty run of ASCII digits. A value too large for u64 saturates, which
/// keeps the range logic right: a huge first byte is past the end, a huge suffix is the
/// whole file and a huge last byte is clamped.
fn parse_digits(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(s.bytes().fold(0u64, |acc, b| acc.saturating_mul(10).saturating_add(u64::from(b - b'0'))))
}

#[cfg(test)]
mod tests {
    use super::RangeOutcome::{Full, Partial, Unsatisfiable};
    use super::*;

    #[test]
    fn no_header_is_full() {
        assert_eq!(evaluate(None, 100), Full);
    }

    #[test]
    fn single_closed_range() {
        assert_eq!(evaluate(Some("bytes=0-0"), 100), Partial { start: 0, end: 0 });
        assert_eq!(evaluate(Some("bytes=10-19"), 100), Partial { start: 10, end: 19 });
        assert_eq!(evaluate(Some("bytes=0-99"), 100), Partial { start: 0, end: 99 });
        assert_eq!(evaluate(Some(" Bytes = 10 - 19 "), 100), Partial { start: 10, end: 19 });
    }

    #[test]
    fn last_byte_past_end_is_clamped() {
        assert_eq!(evaluate(Some("bytes=90-1000"), 100), Partial { start: 90, end: 99 });
        assert_eq!(
            evaluate(Some("bytes=5-99999999999999999999999"), 100),
            Partial { start: 5, end: 99 }
        );
    }

    #[test]
    fn open_ended_range() {
        assert_eq!(evaluate(Some("bytes=0-"), 100), Partial { start: 0, end: 99 });
        assert_eq!(evaluate(Some("bytes=99-"), 100), Partial { start: 99, end: 99 });
    }

    #[test]
    fn suffix_range() {
        assert_eq!(evaluate(Some("bytes=-10"), 100), Partial { start: 90, end: 99 });
        assert_eq!(evaluate(Some("bytes=-100"), 100), Partial { start: 0, end: 99 });
        assert_eq!(evaluate(Some("bytes=-500"), 100), Partial { start: 0, end: 99 });
        assert_eq!(evaluate(Some("bytes=-0"), 100), Unsatisfiable);
        assert_eq!(evaluate(Some("bytes=-5"), 0), Unsatisfiable);
    }

    #[test]
    fn unsatisfiable_first_byte() {
        assert_eq!(evaluate(Some("bytes=100-"), 100), Unsatisfiable);
        assert_eq!(evaluate(Some("bytes=100-200"), 100), Unsatisfiable);
        assert_eq!(evaluate(Some("bytes=0-"), 0), Unsatisfiable);
        assert_eq!(evaluate(Some("bytes=99999999999999999999999-"), 100), Unsatisfiable);
    }

    #[test]
    fn invalid_or_unsupported_headers_are_ignored() {
        for h in [
            "bytes=5-3",
            "bytes=a-b",
            "bytes=-",
            "bytes=",
            "bytes 0-1",
            "items=0-1",
            "bytes=0-1,5-6",
            "bytes=--1",
            "bytes=1",
            "bytes=+1-2",
        ] {
            assert_eq!(evaluate(Some(h), 100), Full, "{h}");
        }
    }

    #[test]
    fn empty_list_elements_are_skipped() {
        assert_eq!(evaluate(Some("bytes=,10-19,"), 100), Partial { start: 10, end: 19 });
    }

    #[test]
    fn sixty_gigabyte_offsets() {
        let len = 60u64 * 1024 * 1024 * 1024;
        assert_eq!(evaluate(Some("bytes=64424509000-"), len), Partial { start: 64_424_509_000, end: len - 1 });
        assert_eq!(evaluate(Some("bytes=-1048576"), len), Partial { start: len - 1_048_576, end: len - 1 });
        assert_eq!(evaluate(Some(&format!("bytes={len}-")), len), Unsatisfiable);
    }
}
