//! Integration tests for the media server (spec 3.7, `server` row): no token means no data,
//! byte ranges are honoured, it is not reachable from another machine. Plus the range edge
//! cases, CORS, files replaced while served, and many simultaneous range requests.

mod common;

use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, UdpSocket};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use rc_server::{MediaItem, MediaServer, BIND_IP};

const SRC: &str = "src-1";

fn with_proxy(len: usize) -> (MediaServer, Arc<MapLocator>, TempDir, Vec<u8>) {
    let (server, locator) = start();
    let dir = TempDir::new("proxy");
    let data = pattern(len, len as u64);
    let path = dir.path("proxy.mp4");
    std::fs::write(&path, &data).unwrap();
    locator.set(SRC, MediaItem::Proxy, &path);
    (server, locator, dir, data)
}

fn target(server: &MediaServer, source: &str, item: MediaItem) -> String {
    target_of(&server.url(source, item)).to_string()
}

// ---------------------------------------------------------------- start, address, token

#[test]
fn start_gives_a_loopback_base_a_system_port_and_a_fresh_token() {
    let (a, _) = start();
    let (b, _) = start();
    assert_eq!(a.local_addr().ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    assert_eq!(BIND_IP, Ipv4Addr::LOCALHOST);
    assert_ne!(a.local_addr().port(), 0);
    assert_ne!(a.local_addr().port(), b.local_addr().port());
    assert_eq!(a.base(), format!("http://127.0.0.1:{}", a.local_addr().port()));
    assert_eq!(a.token().len(), 64);
    assert_ne!(a.token(), b.token(), "a new token every launch");
    assert_eq!(
        a.url("abc", MediaItem::Proxy),
        rc_types::media_url(a.base(), a.token(), "abc", MediaItem::Proxy)
    );
    assert_eq!(a.urls().url("abc", MediaItem::Waveform), a.url("abc", MediaItem::Waveform));
    assert_eq!(a.urls().base(), a.base());
    assert_eq!(a.urls().token(), a.token());
}

#[test]
fn not_reachable_from_another_machine() {
    let (server, _l, _d, _) = with_proxy(1000);
    let port = server.local_addr().port();
    assert!(server.local_addr().ip().is_loopback());

    // The loopback address answers.
    let r = get(server.local_addr(), "GET", &target(&server, SRC, MediaItem::Proxy), &["Connection: close"]);
    assert_eq!(r.status, 200);

    // IPv6 loopback is not bound either.
    let v6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port);
    assert!(TcpStream::connect_timeout(&v6, Duration::from_secs(2)).is_err());

    // This machine's network address (the one another machine would use) gets nothing.
    // A UDP "connect" sends no packet; it only asks the system which local address routes out.
    let lan = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|s| s.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).map(|()| s))
        .and_then(|s| s.local_addr())
        .map(|a| a.ip());
    match lan {
        Ok(ip) if !ip.is_loopback() && !ip.is_unspecified() => {
            let r = TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_secs(3));
            assert!(r.is_err(), "the server answered on the network address {ip}");
            eprintln!("checked network address {ip}: connection refused");
        }
        other => eprintln!("no non-loopback interface on this machine ({other:?}); loopback checks only"),
    }
}

#[test]
fn no_token_means_no_data() {
    let (server, _l, _d, _) = with_proxy(5000);
    let addr = server.local_addr();
    let good = target(&server, SRC, MediaItem::Proxy);
    let base_path = good.split('?').next().unwrap().to_string();
    let token = server.token().to_string();

    let cases: Vec<(String, Vec<String>)> = vec![
        (base_path.clone(), vec![]),
        (format!("{base_path}?token="), vec![]),
        (format!("{base_path}?token=nope"), vec![]),
        (format!("{base_path}?token={}", &token[..63]), vec![]),
        (format!("{base_path}?token={token}0"), vec![]),
        (format!("{base_path}?Token={token}"), vec![]),
        (format!("{base_path}?tok={token}"), vec![]),
        (base_path.clone(), vec![format!("Authorization: Bearer {token}")]),
        (base_path.clone(), vec![format!("X-Token: {token}"), format!("Cookie: token={token}")]),
        (format!("{base_path}#token={token}"), vec![]),
        // Even unknown sources and paths say 401 first, so nothing is learnt without the token.
        ("/media/unknown/proxy".to_string(), vec![]),
        ("/".to_string(), vec![]),
    ];
    for (t, hdrs) in &cases {
        for method in ["GET", "HEAD"] {
            let mut h: Vec<&str> = hdrs.iter().map(String::as_str).collect();
            h.push("Range: bytes=0-");
            let r = get(addr, method, t, &h);
            assert_eq!(r.status, 401, "{method} {t} {hdrs:?}");
            assert_eq!(r.content_length(), Some(0), "401 carries no detail");
            assert!(r.body.is_empty());
            assert!(r.header("content-range").is_none());
            assert_common_headers(&r);
        }
    }
    // The real token works.
    assert_eq!(get(addr, "GET", &good, &[]).status, 200);
}

#[test]
fn unknown_source_or_item_not_ready_is_404() {
    let (server, locator, dir, _) = with_proxy(100);
    let addr = server.local_addr();
    let tok = server.token().to_string();
    for t in [
        target(&server, "nope", MediaItem::Proxy),
        target(&server, SRC, MediaItem::Original),
        target(&server, SRC, MediaItem::Waveform),
        format!("/media/{SRC}/thumbnail?token={tok}"),
        format!("/media/{SRC}/proxy/extra?token={tok}"),
        format!("/other?token={tok}"),
    ] {
        let r = get(addr, "GET", &t, &[]);
        assert_eq!(r.status, 404, "{t}");
        assert!(r.body.is_empty());
        assert_common_headers(&r);
    }
    // A located path that does not exist (yet) or is a folder is also "not ready".
    locator.set(SRC, MediaItem::Original, &dir.path("missing.mov"));
    assert_eq!(get(addr, "GET", &target(&server, SRC, MediaItem::Original), &[]).status, 404);
    locator.set(SRC, MediaItem::Original, &dir.0);
    assert_eq!(get(addr, "GET", &target(&server, SRC, MediaItem::Original), &[]).status, 404);
}

#[test]
fn source_ids_are_percent_decoded() {
    let (server, locator) = start();
    let dir = TempDir::new("ids");
    let id = "sha256:ab/cd é+&?=%";
    let p = dir.path("w.bin");
    std::fs::write(&p, b"hello").unwrap();
    locator.set(id, MediaItem::Proxy, &p);
    let r = get(server.local_addr(), "GET", &target(&server, id, MediaItem::Proxy), &[]);
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"hello");
}

// ---------------------------------------------------------------- ranges

#[test]
fn whole_file_without_range() {
    let (server, _l, _d, data) = with_proxy(1_000_003);
    let r = get(server.local_addr(), "GET", &target(&server, SRC, MediaItem::Proxy), &[]);
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("video/mp4"));
    assert_eq!(r.header("accept-ranges"), Some("bytes"));
    assert_eq!(r.content_length(), Some(data.len() as u64));
    assert!(r.header("content-range").is_none());
    assert_common_headers(&r);
    assert!(r.body == data);
}

#[test]
fn byte_ranges_are_honoured() {
    let len = 1_000_003usize;
    let (server, _l, _d, data) = with_proxy(len);
    let addr = server.local_addr();
    let t = target(&server, SRC, MediaItem::Proxy);
    let l = len as u64;
    // (Range header, expected start, expected inclusive end)
    let cases: Vec<(String, u64, u64)> = vec![
        ("bytes=0-0".into(), 0, 0),
        ("bytes=0-1".into(), 0, 1),
        ("bytes=100-199".into(), 100, 199),
        ("bytes=500000-".into(), 500_000, l - 1),
        ("bytes=0-".into(), 0, l - 1),
        (format!("bytes={}-", l - 1), l - 1, l - 1),
        ("bytes=-1".into(), l - 1, l - 1),
        ("bytes=-4096".into(), l - 4096, l - 1),
        (format!("bytes=-{}", l + 50), 0, l - 1),
        (format!("bytes=999990-{}", l + 1000), 999_990, l - 1),
        ("BYTES = 10-20".into(), 10, 20),
    ];
    for (range, s, e) in cases {
        let h = format!("Range: {range}");
        let r = get(addr, "GET", &t, &[&h]);
        assert_eq!(r.status, 206, "{range}");
        assert_eq!(r.header("content-range"), Some(format!("bytes {s}-{e}/{l}").as_str()), "{range}");
        assert_eq!(r.content_length(), Some(e - s + 1), "{range}");
        assert_eq!(r.header("accept-ranges"), Some("bytes"));
        assert_eq!(r.header("content-type"), Some("video/mp4"));
        assert_common_headers(&r);
        assert!(r.body == data[s as usize..=e as usize], "{range}: wrong bytes");
    }
}

#[test]
fn unsatisfiable_ranges_get_416() {
    let (server, _l, _d, data) = with_proxy(1000);
    let t = target(&server, SRC, MediaItem::Proxy);
    for range in ["bytes=1000-", "bytes=1000-2000", "bytes=5000-5001", "bytes=-0", "bytes=99999999999999999999999-"] {
        let h = format!("Range: {range}");
        for method in ["GET", "HEAD"] {
            let r = get(server.local_addr(), method, &t, &[&h]);
            assert_eq!(r.status, 416, "{method} {range}");
            assert_eq!(r.header("content-range"), Some(format!("bytes */{}", data.len()).as_str()));
            assert_eq!(r.content_length(), Some(0));
            assert_common_headers(&r);
        }
    }
}

#[test]
fn ranges_the_server_does_not_handle_get_the_whole_file() {
    let (server, _l, _d, data) = with_proxy(2000);
    let t = target(&server, SRC, MediaItem::Proxy);
    for range in ["bytes=0-1,5-9", "bytes=9-3", "lines=0-1", "bytes=x-"] {
        let h = format!("Range: {range}");
        let r = get(server.local_addr(), "GET", &t, &[&h]);
        assert_eq!(r.status, 200, "{range}");
        assert!(r.body == data);
    }
}

#[test]
fn empty_file_serves_200_and_416() {
    let (server, locator) = start();
    let dir = TempDir::new("empty");
    let p = dir.path("empty.mp4");
    std::fs::write(&p, b"").unwrap();
    locator.set(SRC, MediaItem::Proxy, &p);
    let t = target(&server, SRC, MediaItem::Proxy);
    let r = get(server.local_addr(), "GET", &t, &[]);
    assert_eq!(r.status, 200);
    assert_eq!(r.content_length(), Some(0));
    let r = get(server.local_addr(), "GET", &t, &["Range: bytes=0-"]);
    assert_eq!(r.status, 416);
}

#[test]
fn head_has_the_get_headers_and_no_body() {
    let (server, _l, _d, data) = with_proxy(123_456);
    let t = target(&server, SRC, MediaItem::Proxy);
    let mut c = Conn::open(server.local_addr());
    let r = c.request("HEAD", &t, &[]);
    assert_eq!(r.status, 200);
    assert_eq!(r.content_length(), Some(data.len() as u64));
    assert_eq!(r.header("accept-ranges"), Some("bytes"));
    assert_eq!(r.header("content-type"), Some("video/mp4"));
    assert_common_headers(&r);
    let r = c.request("HEAD", &t, &["Range: bytes=10-"]);
    assert_eq!(r.status, 206);
    assert_eq!(r.header("content-range"), Some("bytes 10-123455/123456"));
    assert_eq!(r.content_length(), Some(123_446));
    // No body was sent: the next response on the same connection parses cleanly.
    let r = c.request("GET", &t, &["Range: bytes=0-3"]);
    assert_eq!(r.status, 206);
    assert_eq!(r.body, data[..4]);
}

#[test]
fn content_types() {
    let (server, locator) = start();
    let dir = TempDir::new("types");
    let header = rc_types::WaveformHeader { source_id: "w".into(), values_per_second: 100, count: 5 };
    let wave = rc_types::write_waveform(&header, &[0, 10, 255, 3, 0]).unwrap();
    std::fs::write(dir.path("wave.bin"), &wave).unwrap();
    locator.set("w", MediaItem::Waveform, &dir.path("wave.bin"));
    for (name, ct) in [
        ("a.MOV", "video/quicktime"),
        ("a.mp4", "video/mp4"),
        ("a.mkv", "video/x-matroska"),
        ("a.webm", "video/webm"),
        ("a.mts", "video/mp2t"),
        ("a.weird", "application/octet-stream"),
    ] {
        std::fs::write(dir.path(name), b"x").unwrap();
        locator.set(name, MediaItem::Original, &dir.path(name));
        let r = get(server.local_addr(), "HEAD", &target(&server, name, MediaItem::Original), &[]);
        assert_eq!(r.status, 200);
        assert_eq!(r.header("content-type"), Some(ct), "{name}");
        assert_eq!(r.header("accept-ranges"), Some("bytes"));
    }
    // The waveform as the interface fetches it: with an Origin, and readable by read_waveform.
    let r = get(
        server.local_addr(),
        "GET",
        &target(&server, "w", MediaItem::Waveform),
        &["Origin: http://tauri.localhost"],
    );
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-type"), Some("application/octet-stream"));
    assert_common_headers(&r);
    let (h, values) = rc_types::read_waveform(&r.body).unwrap();
    assert_eq!(h, header);
    assert_eq!(values, vec![0, 10, 255, 3, 0]);
}

// ---------------------------------------------------------------- CORS and odd requests

#[test]
fn every_response_carries_cors() {
    let (server, _l, _d, _) = with_proxy(10);
    let addr = server.local_addr();
    let t = target(&server, SRC, MediaItem::Proxy);

    // Preflight: no token needed, and it allows the Range header.
    let r = get(
        addr,
        "OPTIONS",
        "/media/src-1/waveform",
        &[
            "Origin: http://localhost:1420",
            "Access-Control-Request-Method: GET",
            "Access-Control-Request-Headers: range",
        ],
    );
    assert_eq!(r.status, 204);
    assert_common_headers(&r);
    assert!(r.header("access-control-allow-methods").unwrap().contains("GET"));
    assert_eq!(r.header("access-control-allow-headers"), Some("range"));

    let r = get(addr, "POST", &t, &["Content-Length: 0"]);
    assert_eq!(r.status, 405);
    assert_common_headers(&r);

    let r = get(addr, "GET", &t, &["Origin: http://tauri.localhost", "Range: bytes=0-"]);
    assert_eq!(r.status, 206);
    assert_common_headers(&r);
    assert!(r.header("access-control-expose-headers").unwrap().contains("Content-Range"));

    // A malformed request gets 400, still with CORS, and the connection closes.
    let mut c = Conn::open(addr);
    c.stream.write_all(b"this is not http\r\n\r\n").unwrap();
    let r = c.read_head();
    assert_eq!(r.status, 400);
    assert_common_headers(&r);
    let n = r.content_length().unwrap();
    assert_eq!(c.read_body(n).len() as u64, n);
    assert!(c.is_closed());
}

#[test]
fn keep_alive_serves_many_requests_on_one_connection() {
    let (server, _l, _d, data) = with_proxy(300_000);
    let t = target(&server, SRC, MediaItem::Proxy);
    let mut c = Conn::open(server.local_addr());
    for i in 0..50u64 {
        let s = i * 5000;
        let h = format!("Range: bytes={s}-{}", s + 999);
        let r = c.request("GET", &t, &[&h]);
        assert_eq!(r.status, 206);
        assert_eq!(r.header("connection"), Some("keep-alive"));
        assert!(r.body == data[s as usize..s as usize + 1000]);
    }
    let r = c.request("GET", &t, &["Range: bytes=0-0", "Connection: close"]);
    assert_eq!(r.header("connection"), Some("close"));
    assert!(c.is_closed());
}

#[test]
fn shutdown_stops_listening() {
    let (server, _l, _d, _) = with_proxy(10);
    let addr = server.local_addr();
    // A connection left open (as a paused video element does) must not block shutdown.
    let mut idle = Conn::open(addr);
    idle.send("GET", &target(&server, SRC, MediaItem::Proxy), &["Range: bytes=0-0"]);
    // Read the whole response so is_closed() below sees EOF, not the body byte.
    let r = idle.read_head();
    assert_eq!(r.status, 206);
    assert_eq!(idle.read_body(r.content_length().unwrap()).len(), 1);
    let started = Instant::now();
    server.shutdown();
    assert!(started.elapsed() < Duration::from_secs(5), "shutdown took {:?}", started.elapsed());
    assert!(TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_err());
    assert!(idle.is_closed());
}

#[test]
fn starting_inside_an_async_runtime_works() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let (server, _l) = start();
        let addr = server.local_addr();
        let t = target(&server, "x", MediaItem::Proxy);
        let r = tokio::task::spawn_blocking(move || get(addr, "GET", &t, &[])).await.unwrap();
        assert_eq!(r.status, 404);
        drop(server);
    });
}
