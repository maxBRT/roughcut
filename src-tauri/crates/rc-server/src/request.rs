//! HTTP/1.1 request head parsing, request targets and the token.

use rc_types::{MediaItem, MEDIA_TOKEN_PARAM};

/// The longest request head accepted (request line plus headers).
pub(crate) const MAX_HEAD_BYTES: usize = 16 * 1024;

/// A parsed request head.
#[derive(Debug, Clone)]
pub(crate) struct RequestHead {
    pub method: String,
    pub target: String,
    /// `HTTP/1.0` or `HTTP/1.1`, as sent.
    pub version: String,
    pub headers: Vec<(String, String)>,
}

impl RequestHead {
    /// The first header named `name` (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// Whether the connection stays open after the response.
    pub fn keep_alive(&self) -> bool {
        let conn = self.header("connection").unwrap_or("").to_ascii_lowercase();
        let has = |t: &str| conn.split(',').any(|p| p.trim() == t);
        if self.version == "HTTP/1.0" { has("keep-alive") } else { !has("close") }
    }
}

/// Parses a complete request head (everything before the blank line, CRLF or LF line
/// ends). `None` for anything malformed.
pub(crate) fn parse_head(raw: &[u8]) -> Option<RequestHead> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l));
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let version = parts.next()?.to_string();
    if parts.next().is_some()
        || method.is_empty()
        || target.is_empty()
        || !(version == "HTTP/1.1" || version == "HTTP/1.0")
    {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':')?;
        if name.is_empty() || name.contains([' ', '\t']) {
            return None;
        }
        headers.push((name.to_string(), value.trim().to_string()));
    }
    Some(RequestHead { method, target, version, headers })
}

/// Splits a request target into its decoded path segments and its raw query.
/// Accepts origin form (`/media/a/proxy?token=x`) and absolute form
/// (`http://127.0.0.1:1234/media/a/proxy?token=x`).
pub(crate) fn split_target(target: &str) -> (&str, &str) {
    let target = match target.find("://") {
        Some(i) if !target[..i].contains('/') => {
            let rest = &target[i + 3..];
            rest.find(['/', '?']).map_or("/", |j| &rest[j..])
        }
        _ => target,
    };
    let target = target.split_once('#').map_or(target, |(t, _)| t);
    target.split_once('?').unwrap_or((target, ""))
}

/// The value of the `token` query parameter (the first one), percent-decoded.
pub(crate) fn token_param(query: &str) -> Option<Vec<u8>> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(k)? == MEDIA_TOKEN_PARAM.as_bytes()).then(|| percent_decode(v)).flatten()
    })
}

/// `/media/{sourceId}/{item}` with the source id percent-decoded. `None` for any other path.
pub(crate) fn media_path(path: &str) -> Option<(String, MediaItem)> {
    let rest = path.strip_prefix("/media/")?;
    let mut segs = rest.split('/');
    let id = segs.next()?;
    let item = segs.next()?;
    if segs.next().is_some() || id.is_empty() {
        return None;
    }
    let id = String::from_utf8(percent_decode(id)?).ok()?;
    let item = MediaItem::parse(item)?;
    Some((id, item))
}

/// Decodes `%XX` escapes. `None` when an escape is malformed.
pub(crate) fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3)?;
            let hi = (hex[0] as char).to_digit(16)?;
            let lo = (hex[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    Some(out)
}

/// Compares two byte strings in time that depends only on their lengths.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A fresh per-launch token: 32 random bytes from the operating system, as 64 hex digits.
pub(crate) fn new_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::media_url;

    #[test]
    fn parses_a_head() {
        let h = parse_head(b"GET /media/x/proxy?token=a HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-\r\n").unwrap();
        assert_eq!(h.method, "GET");
        assert_eq!(h.target, "/media/x/proxy?token=a");
        assert_eq!(h.header("range"), Some("bytes=0-"));
        assert!(h.keep_alive());
        assert!(parse_head(b"GET /x HTTP/2\r\n").is_none());
        assert!(parse_head(b"GET /x\r\n").is_none());
        assert!(parse_head(b"GET /x HTTP/1.1\r\nBad header\r\n").is_none());
    }

    #[test]
    fn keep_alive_rules() {
        let h = parse_head(b"GET / HTTP/1.1\r\nConnection: close\r\n").unwrap();
        assert!(!h.keep_alive());
        let h = parse_head(b"GET / HTTP/1.0\r\n").unwrap();
        assert!(!h.keep_alive());
        let h = parse_head(b"GET / HTTP/1.0\r\nConnection: Keep-Alive\r\n").unwrap();
        assert!(h.keep_alive());
    }

    #[test]
    fn round_trips_media_url() {
        let id = "sha/1 x+%é";
        let token = "t&k=n";
        let url = media_url("http://127.0.0.1:5000/", token, id, MediaItem::Waveform);
        let (path, query) = split_target(&url);
        assert_eq!(media_path(path), Some((id.to_string(), MediaItem::Waveform)));
        assert_eq!(token_param(query), Some(token.as_bytes().to_vec()));
    }

    #[test]
    fn rejects_other_paths() {
        assert_eq!(media_path("/media/a/b/proxy"), None);
        assert_eq!(media_path("/media//proxy"), None);
        assert_eq!(media_path("/media/a/thumbnail"), None);
        assert_eq!(media_path("/other/a/proxy"), None);
        assert_eq!(media_path("/media/%zz/proxy"), None);
    }

    #[test]
    fn token_param_is_found_only_by_name() {
        assert_eq!(token_param("a=1&token=abc&token=def"), Some(b"abc".to_vec()));
        assert_eq!(token_param("tokens=abc"), None);
        assert_eq!(token_param(""), None);
        assert_eq!(token_param("token"), Some(Vec::new()));
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(constant_time_eq(a.as_bytes(), a.as_bytes()));
        assert!(!constant_time_eq(a.as_bytes(), b.as_bytes()));
        assert!(!constant_time_eq(b"ab", b"abc"));
    }
}
