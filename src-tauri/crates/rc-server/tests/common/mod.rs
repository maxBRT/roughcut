//! Helpers shared by the integration tests: a tiny blocking HTTP/1.1 client, a locator
//! backed by a map and unique temporary folders.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rc_server::{MediaItem, MediaLocator, MediaServer};

/// A locator whose answers the test changes while the server runs.
#[derive(Default)]
pub struct MapLocator {
    files: Mutex<HashMap<(String, MediaItem), PathBuf>>,
}

impl MapLocator {
    pub fn set(&self, source: &str, item: MediaItem, path: &Path) {
        self.files.lock().unwrap().insert((source.to_string(), item), path.to_path_buf());
    }
    pub fn clear(&self, source: &str, item: MediaItem) {
        self.files.lock().unwrap().remove(&(source.to_string(), item));
    }
}

impl MediaLocator for MapLocator {
    fn locate(&self, source_id: &str, item: MediaItem) -> Option<PathBuf> {
        self.files.lock().unwrap().get(&(source_id.to_string(), item)).cloned()
    }
}

/// Starts a server over a fresh `MapLocator`.
pub fn start() -> (MediaServer, Arc<MapLocator>) {
    let locator = Arc::new(MapLocator::default());
    let server = MediaServer::start(locator.clone()).expect("server starts");
    (server, locator)
}

/// A fresh, empty folder under the system temporary folder. Removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> TempDir {
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "rc-server-test-{tag}-{}-{nanos}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
    pub fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Deterministic, non-repeating-looking test content.
pub fn pattern(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

/// A parsed response.
#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn content_length(&self) -> Option<u64> {
        self.header("content-length").map(|v| v.parse().unwrap())
    }
}

/// The path and query of a full address, for writing the request line.
pub fn target_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    &rest[rest.find('/').unwrap_or(rest.len())..]
}

/// A connection that may carry several requests.
pub struct Conn {
    pub stream: TcpStream,
    buf: Vec<u8>,
}

impl Conn {
    pub fn open(addr: SocketAddr) -> Conn {
        let stream = TcpStream::connect(addr).expect("connect");
        stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        stream.set_nodelay(true).unwrap();
        Conn { stream, buf: Vec::new() }
    }

    /// Sends `method target` with extra header lines (each without CRLF).
    pub fn send(&mut self, method: &str, target: &str, headers: &[&str]) {
        let mut req = format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        for h in headers {
            req.push_str(h);
            req.push_str("\r\n");
        }
        req.push_str("\r\n");
        self.stream.write_all(req.as_bytes()).unwrap();
    }

    /// Reads a response head; the body is left on the connection.
    pub fn read_head(&mut self) -> Response {
        loop {
            if let Some(i) = self.buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8(self.buf[..i].to_vec()).unwrap();
                self.buf.drain(..i + 4);
                let mut lines = head.split("\r\n");
                let status_line = lines.next().unwrap();
                let status = status_line.split(' ').nth(1).unwrap().parse().unwrap();
                let headers = lines
                    .map(|l| {
                        let (n, v) = l.split_once(':').unwrap();
                        (n.to_string(), v.trim().to_string())
                    })
                    .collect();
                return Response { status, headers, body: Vec::new() };
            }
            let mut chunk = [0u8; 8192];
            let n = self.stream.read(&mut chunk).expect("read head");
            assert!(n > 0, "connection closed before a response head");
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }

    /// Reads up to `n` body bytes (fewer only if the server closes the connection).
    pub fn read_body(&mut self, n: u64) -> Vec<u8> {
        let n = usize::try_from(n).unwrap();
        let mut out = Vec::with_capacity(n.min(64 << 20));
        let take = self.buf.len().min(n);
        out.extend(self.buf.drain(..take));
        let mut chunk = vec![0u8; 256 * 1024];
        while out.len() < n {
            let want = (n - out.len()).min(chunk.len());
            match self.stream.read(&mut chunk[..want]) {
                Ok(0) | Err(_) => break,
                Ok(k) => out.extend_from_slice(&chunk[..k]),
            }
        }
        out
    }

    /// Reads and discards `n` body bytes; returns how many arrived.
    pub fn skip_body(&mut self, n: u64) -> u64 {
        let mut got = 0u64;
        let take = self.buf.len().min(usize::try_from(n).unwrap_or(usize::MAX));
        self.buf.drain(..take);
        got += take as u64;
        let mut chunk = vec![0u8; 1 << 20];
        while got < n {
            let want = usize::try_from(n - got).unwrap_or(usize::MAX).min(chunk.len());
            match self.stream.read(&mut chunk[..want]) {
                Ok(0) | Err(_) => break,
                Ok(k) => got += k as u64,
            }
        }
        got
    }

    /// Sends one request and reads the whole response (no body for HEAD).
    pub fn request(&mut self, method: &str, target: &str, headers: &[&str]) -> Response {
        self.send(method, target, headers);
        let mut resp = self.read_head();
        if method != "HEAD" {
            let len = resp.content_length().expect("every response has a Content-Length");
            resp.body = self.read_body(len);
            assert_eq!(resp.body.len() as u64, len, "short body");
        }
        resp
    }

    /// True when the server has closed the connection (reads EOF or reset).
    /// Panics if unread response bytes remain, because then a read could not
    /// tell a close from leftover data; a read timeout means "still open".
    pub fn is_closed(&mut self) -> bool {
        assert!(self.buf.is_empty(), "is_closed called with {} unread bytes buffered", self.buf.len());
        let mut b = [0u8; 1];
        match self.stream.read(&mut b) {
            Ok(0) => true,
            Ok(_) => panic!("is_closed read response data; read the whole body first"),
            Err(e) => !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut),
        }
    }
}

/// One request on a fresh connection.
pub fn get(addr: SocketAddr, method: &str, target: &str, headers: &[&str]) -> Response {
    Conn::open(addr).request(method, target, headers)
}

/// Asserts the headers every response must carry.
pub fn assert_common_headers(r: &Response) {
    assert_eq!(r.header("access-control-allow-origin"), Some("*"), "status {}: {:?}", r.status, r.headers);
    assert_eq!(r.header("cache-control"), Some("no-store"), "status {}", r.status);
}
