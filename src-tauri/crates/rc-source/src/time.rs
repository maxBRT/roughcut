//! ISO 8601 timestamps in UTC with milliseconds, e.g. `2026-11-13T09:05:01.250Z`, without a
//! date library. Every timestamp the storage crates write has this exact fixed-width form,
//! so comparing two of them as strings orders them in time.

use std::time::{SystemTime, UNIX_EPOCH};

/// The current time as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn now_iso() -> String {
    format_iso_millis(unix_millis_now())
}

/// Milliseconds since 1970-01-01 UTC, now.
pub fn unix_millis_now() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// `millis` since the Unix epoch as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn format_iso_millis(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let in_day = millis.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let h = in_day / 3_600_000;
    let min = in_day / 60_000 % 60;
    let s = in_day / 1000 % 60;
    let ms = in_day % 1000;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{ms:03}Z")
}

/// Reads an ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SS[.fff]Z`, or with a `+00:00`
/// offset) back into milliseconds since the Unix epoch. `None` for anything else.
pub fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(r)?;
        if part.bytes().all(|c| c.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    let (y, mo, d, h, mi, sec) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let mut scaled = String::from(&frac[..digits.min(3)]);
        while scaled.len() < 3 {
            scaled.push('0');
        }
        ms = scaled.parse().ok()?;
        rest = &frac[digits..];
    }
    if !(rest == "Z" || rest == "z" || rest == "+00:00") {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    Some(((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + ms)
}

// Howard Hinnant's civil calendar algorithms.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_dates() {
        assert_eq!(format_iso_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(format_iso_millis(1_794_560_401_250), "2026-11-13T09:00:01.250Z");
        assert_eq!(parse_iso_millis("2026-11-13T09:00:01.250Z"), Some(1_794_560_401_250));
        assert_eq!(parse_iso_millis("2026-11-13T09:00:01Z"), Some(1_794_560_401_000));
        assert_eq!(parse_iso_millis("2026-11-13T09:00:01.25+00:00"), Some(1_794_560_401_250));
        assert_eq!(parse_iso_millis("yesterday"), None);
    }

    #[test]
    fn round_trips_and_orders_as_strings() {
        let mut prev = String::new();
        let mut t = -86_400_000i64 * 400;
        while t < 4_102_444_800_000 {
            let s = format_iso_millis(t);
            assert_eq!(parse_iso_millis(&s), Some(t), "{s}");
            if t >= 0 {
                assert!(s > prev, "{s} after {prev}");
                prev = s;
            }
            t += 7_777_777_777;
        }
        assert!(now_iso().ends_with('Z'));
    }
}
