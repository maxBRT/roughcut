//! Review probes (track server-review): edge cases of request framing and connection
//! handling that the author's tests do not exercise.

mod common;

use std::io::Write;
use std::time::Duration;

use common::*;
use rc_server::MediaItem;

const SRC: &str = "src-1";

fn setup(len: usize) -> (rc_server::MediaServer, std::sync::Arc<MapLocator>, TempDir, Vec<u8>, String) {
    let (server, locator) = start();
    let dir = TempDir::new("review");
    let data = pattern(len, 3);
    let p = dir.path("proxy.mp4");
    std::fs::write(&p, &data).unwrap();
    locator.set(SRC, MediaItem::Proxy, &p);
    let t = target_of(&server.url(SRC, MediaItem::Proxy)).to_string();
    (server, locator, dir, data, t)
}

#[test]
fn review_pipelined_requests_are_answered_in_order() {
    let (server, _l, _d, data, t) = setup(10_000);
    let mut c = Conn::open(server.local_addr());
    let req = format!(
        "GET {t} HTTP/1.1\r\nHost: x\r\nRange: bytes=0-9\r\n\r\nGET {t} HTTP/1.1\r\nHost: x\r\nRange: bytes=10-19\r\n\r\n"
    );
    c.stream.write_all(req.as_bytes()).unwrap();
    let r = c.read_head();
    assert_eq!(r.status, 206);
    assert_eq!(c.read_body(10), data[..10]);
    let r = c.read_head();
    assert_eq!(r.status, 206);
    assert_eq!(c.read_body(10), data[10..20]);
}

#[test]
fn review_head_sent_one_byte_at_a_time() {
    let (server, _l, _d, data, t) = setup(100);
    let mut c = Conn::open(server.local_addr());
    let req = format!("GET {t} HTTP/1.1\r\nHost: x\r\nRange: bytes=5-9\r\n\r\n");
    for b in req.as_bytes() {
        c.stream.write_all(&[*b]).unwrap();
        c.stream.flush().unwrap();
        std::thread::sleep(Duration::from_micros(200));
    }
    let r = c.read_head();
    assert_eq!(r.status, 206);
    assert_eq!(c.read_body(5), data[5..10]);
}

#[test]
fn review_many_concurrent_full_streams_all_progress() {
    // More open streams than the blocking pool (64) has threads: each must still progress.
    let (server, _l, _d, data, t) = setup(4 * 1024 * 1024);
    let addr = server.local_addr();
    let mut conns: Vec<Conn> = (0..100)
        .map(|_| {
            let mut c = Conn::open(addr);
            c.send("GET", &t, &["Range: bytes=0-"]);
            assert_eq!(c.read_head().status, 206);
            c
        })
        .collect();
    for c in &mut conns {
        let got = c.read_body(data.len() as u64);
        assert!(got == data);
    }
}

#[test]
fn review_shutdown_idle_server_is_prompt() {
    let (server, _l) = start();
    let started = std::time::Instant::now();
    server.shutdown();
    let took = started.elapsed();
    eprintln!("shutdown with no connections took {took:?}");
    assert!(took < Duration::from_millis(500), "shutdown took {took:?}");
}

#[test]
fn review_shutdown_after_one_served_request_is_prompt() {
    let (server, _l, _d, _data, t) = setup(100);
    let mut c = Conn::open(server.local_addr());
    let r = c.request("GET", &t, &["Range: bytes=0-0"]);
    assert_eq!(r.status, 206);
    let started = std::time::Instant::now();
    server.shutdown();
    let took = started.elapsed();
    eprintln!("shutdown after one served request (idle keep-alive) took {took:?}");
    assert!(c.is_closed(), "idle keep-alive connection closed by shutdown");
    assert!(took < Duration::from_millis(500), "shutdown took {took:?}");
}

#[test]
fn review_shutdown_timing_as_in_author_test() {
    let (server, _l, _d, _data, t) = setup(10);
    let mut idle = Conn::open(server.local_addr());
    idle.send("GET", &t, &["Range: bytes=0-0"]);
    let _ = idle.read_head();
    let started = std::time::Instant::now();
    server.shutdown();
    let took = started.elapsed();
    eprintln!("shutdown with body byte unread by client took {took:?}");
    assert!(took < Duration::from_millis(500), "shutdown took {took:?}");
}

#[test]
fn review_handle_is_send_and_sync_for_app_state() {
    fn assert_send_sync<T: Send + Sync + 'static>() {}
    assert_send_sync::<rc_server::MediaServer>();
    assert_send_sync::<rc_server::MediaUrls>();
}

#[test]
fn review_closure_locator_is_accepted() {
    let dir = TempDir::new("closure");
    let p = dir.path("w.bin");
    std::fs::write(&p, b"abc").unwrap();
    let p2 = p.clone();
    let server = rc_server::MediaServer::start(std::sync::Arc::new(move |id: &str, item: MediaItem| {
        (id == "s" && item == MediaItem::Waveform).then(|| p2.clone())
    }))
    .unwrap();
    let r = get(server.local_addr(), "GET", target_of(&server.url("s", MediaItem::Waveform)), &[]);
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"abc");
}

#[test]
fn review_client_abandoning_many_streams_leaves_server_healthy() {
    // Browsers abort range requests on every seek; 300 aborted 4 MiB streams in a row.
    let (server, _l, _d, data, t) = setup(4 * 1024 * 1024);
    let addr = server.local_addr();
    for _ in 0..300 {
        let mut c = Conn::open(addr);
        c.send("GET", &t, &["Range: bytes=0-"]);
        assert_eq!(c.read_head().status, 206);
        let _ = c.read_body(1000);
        drop(c);
    }
    let r = get(addr, "GET", &t, &["Range: bytes=100-199"]);
    assert_eq!(r.body, data[100..200]);
}
