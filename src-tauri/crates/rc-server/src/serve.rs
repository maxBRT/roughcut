//! One connection: read request heads, answer them, stream file bytes.

use std::io::{self, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rc_types::MediaItem;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::range::{evaluate, RangeOutcome};
use crate::request::{
    constant_time_eq, media_path, parse_head, split_target, token_param, RequestHead, MAX_HEAD_BYTES,
};
use crate::MediaLocator;

/// How long an idle keep-alive connection, or a slow request head, is waited for.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Size of each read from the file while streaming a body.
const CHUNK: usize = 256 * 1024;

/// What every connection task shares.
pub(crate) struct Shared {
    pub token: String,
    pub locator: Arc<dyn MediaLocator>,
}

/// Serves requests on one connection until it closes, errors or idles out.
pub(crate) async fn connection(mut stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nodelay(true);
    let mut pending: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let head = match read_head(&mut stream, &mut pending).await {
            Ok(Some(h)) => h,
            Ok(None) => return,
            Err(HeadError::Malformed) => {
                let _ = write_simple(&mut stream, 400, "Bad Request", false, &[]).await;
                return;
            }
            Err(HeadError::TooLarge) => {
                let _ = write_simple(&mut stream, 431, "Request Header Fields Too Large", false, &[]).await;
                return;
            }
        };
        // Requests with a body are never needed here; answer and close instead of
        // reading the body, so the next request on the connection is never misread.
        let has_body = head.header("transfer-encoding").is_some()
            || head.header("content-length").is_some_and(|v| v.trim() != "0");
        let keep = head.keep_alive() && !has_body;
        match respond(&mut stream, &head, keep, &shared, &mut chunk).await {
            Ok(true) if keep => continue,
            _ => return,
        }
    }
}

enum HeadError {
    Malformed,
    TooLarge,
}

/// Reads the next request head. `Ok(None)` when the peer closed or went idle.
async fn read_head(stream: &mut TcpStream, pending: &mut Vec<u8>) -> Result<Option<RequestHead>, HeadError> {
    loop {
        if let Some((head_end, total)) = find_head_end(pending) {
            let head = parse_head(&pending[..head_end]);
            pending.drain(..total);
            return head.map(Some).ok_or(HeadError::Malformed);
        }
        if pending.len() > MAX_HEAD_BYTES {
            return Err(HeadError::TooLarge);
        }
        let mut buf = [0u8; 4096];
        let n = match tokio::time::timeout(IDLE_TIMEOUT, stream.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(_)) | Err(_) => return Ok(None),
        };
        if n == 0 {
            return Ok(None);
        }
        pending.extend_from_slice(&buf[..n]);
        // Tolerate blank lines before a request line (RFC 9112 section 2.2).
        while pending.first().is_some_and(|b| *b == b'\r' || *b == b'\n') {
            pending.remove(0);
        }
    }
}

/// Position of the end of the head (exclusive) and of the blank line after it.
fn find_head_end(buf: &[u8]) -> Option<(usize, usize)> {
    for i in 0..buf.len() {
        if buf[i..].starts_with(b"\r\n\r\n") {
            return Some((i, i + 4));
        }
        if buf[i..].starts_with(b"\n\n") {
            return Some((i, i + 2));
        }
    }
    None
}

/// Answers one request. `Ok(true)` when the response was sent completely.
async fn respond(
    stream: &mut TcpStream,
    head: &RequestHead,
    keep: bool,
    shared: &Shared,
    chunk: &mut [u8],
) -> io::Result<bool> {
    let method = head.method.as_str();
    if method == "OPTIONS" {
        // CORS preflight. It carries no credentials and returns no data, so it needs no token.
        let allow_headers = head.header("access-control-request-headers").unwrap_or("Range").to_string();
        let headers = [
            ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS".to_string()),
            ("Access-Control-Allow-Headers", allow_headers),
            ("Access-Control-Allow-Private-Network", "true".to_string()),
            ("Access-Control-Max-Age", "600".to_string()),
            ("Allow", "GET, HEAD, OPTIONS".to_string()),
        ];
        return write_simple(stream, 204, "No Content", keep, &headers).await.map(|()| true);
    }
    if method != "GET" && method != "HEAD" {
        let headers = [("Allow", "GET, HEAD, OPTIONS".to_string())];
        return write_simple(stream, 405, "Method Not Allowed", keep, &headers).await.map(|()| true);
    }

    let (path, query) = split_target(&head.target);
    let authorised = token_param(query).is_some_and(|t| constant_time_eq(&t, shared.token.as_bytes()));
    if !authorised {
        return write_simple(stream, 401, "Unauthorized", keep, &[]).await.map(|()| true);
    }
    let Some((source_id, item)) = media_path(path) else {
        return write_simple(stream, 404, "Not Found", keep, &[]).await.map(|()| true);
    };

    let locator = Arc::clone(&shared.locator);
    let opened = tokio::task::spawn_blocking(move || {
        let path = locator.locate(&source_id, item)?;
        let file = open_shared(&path).ok()?;
        let meta = file.metadata().ok()?;
        meta.is_file().then_some((file, meta.len(), path))
    })
    .await
    .ok()
    .flatten();
    let Some((file, len, file_path)) = opened else {
        return write_simple(stream, 404, "Not Found", keep, &[]).await.map(|()| true);
    };

    let (status, reason, start, count, content_range) = match evaluate(head.header("range"), len) {
        RangeOutcome::Full => (200, "OK", 0, len, None),
        RangeOutcome::Partial { start, end } => {
            (206, "Partial Content", start, end - start + 1, Some(format!("bytes {start}-{end}/{len}")))
        }
        RangeOutcome::Unsatisfiable => {
            let headers = [
                ("Content-Range", format!("bytes */{len}")),
                ("Accept-Ranges", "bytes".to_string()),
            ];
            return write_simple(stream, 416, "Range Not Satisfiable", keep, &headers).await.map(|()| true);
        }
    };

    let mut headers = vec![
        ("Content-Type", content_type(item, &file_path).to_string()),
        ("Accept-Ranges", "bytes".to_string()),
    ];
    if let Some(cr) = content_range {
        headers.push(("Content-Range", cr));
    }
    write_head(stream, status, reason, keep, count, &headers).await?;
    if method == "HEAD" || count == 0 {
        return Ok(true);
    }

    let mut file = tokio::fs::File::from_std(file);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await?;
    }
    let mut remaining = count;
    while remaining > 0 {
        let want = usize::try_from(remaining).map_or(chunk.len(), |r| r.min(chunk.len()));
        let n = file.read(&mut chunk[..want]).await?;
        if n == 0 {
            // The file shrank after the length was sent; the response cannot be completed,
            // so the connection is closed and the client sees a short body.
            return Ok(false);
        }
        stream.write_all(&chunk[..n]).await?;
        remaining -= n as u64;
    }
    Ok(true)
}

/// Opens a file for reading while letting others write, rename or delete it. Replacing the
/// proxy while it is being served therefore succeeds, and this handle keeps reading the
/// file it opened.
fn open_shared(path: &Path) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        options.share_mode(0x1 | 0x2 | 0x4);
    }
    options.open(path)
}

/// The Content-Type for an item. The proxy is always MP4; the original goes by its extension.
fn content_type(item: MediaItem, path: &Path) -> &'static str {
    match item {
        MediaItem::Proxy => "video/mp4",
        MediaItem::Waveform => "application/octet-stream",
        MediaItem::Original => {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            match ext.as_str() {
                "mp4" | "m4v" => "video/mp4",
                "mov" | "qt" => "video/quicktime",
                "mkv" => "video/x-matroska",
                "webm" => "video/webm",
                "avi" => "video/x-msvideo",
                "mxf" => "application/mxf",
                "ts" | "mts" | "m2ts" => "video/mp2t",
                _ => "application/octet-stream",
            }
        }
    }
}

/// Writes a response head. Every response carries the CORS and no-store headers.
async fn write_head(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    keep: bool,
    content_length: u64,
    extra: &[(&str, String)],
) -> io::Result<()> {
    let mut s = format!("HTTP/1.1 {status} {reason}\r\n");
    s.push_str("Access-Control-Allow-Origin: *\r\n");
    s.push_str("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n");
    s.push_str("Cache-Control: no-store\r\n");
    s.push_str(&format!("Content-Length: {content_length}\r\n"));
    for (name, value) in extra {
        s.push_str(&format!("{name}: {value}\r\n"));
    }
    s.push_str(if keep { "Connection: keep-alive\r\n" } else { "Connection: close\r\n" });
    s.push_str("\r\n");
    stream.write_all(s.as_bytes()).await
}

/// Writes a response with no body.
async fn write_simple(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    keep: bool,
    extra: &[(&str, String)],
) -> io::Result<()> {
    write_head(stream, status, reason, keep, 0, extra).await
}
