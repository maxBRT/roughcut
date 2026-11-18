//! Load and robustness: many simultaneous range requests of the kind two video elements
//! make, files replaced while they are served, and a 60 GB file streamed without reading it
//! into memory.

mod common;

use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use rc_server::MediaItem;

const SRC: &str = "src-1";

fn target(server: &rc_server::MediaServer, source: &str, item: MediaItem) -> String {
    target_of(&server.url(source, item)).to_string()
}

#[test]
fn many_simultaneous_range_requests_like_two_video_elements() {
    let (server, locator) = start();
    let dir = TempDir::new("load");
    let len = 16 * 1024 * 1024 + 17;
    let data = Arc::new(pattern(len, 7));
    let p = dir.path("proxy.mp4");
    std::fs::write(&p, &*data).unwrap();
    locator.set(SRC, MediaItem::Proxy, &p);
    let addr = server.local_addr();
    let t = Arc::new(target(&server, SRC, MediaItem::Proxy));
    let stop = Arc::new(AtomicBool::new(false));

    // Two "playing" elements: each holds a long open-ended request on its own connection
    // and reads it slowly, as Chromium does while it buffers.
    let streamers: Vec<_> = (0..2)
        .map(|i| {
            let (t, stop, data) = (t.clone(), stop.clone(), data.clone());
            std::thread::spawn(move || {
                let mut c = Conn::open(addr);
                let start = i * 1_000_000u64;
                let h = format!("Range: bytes={start}-");
                c.send("GET", &t, &[&h]);
                let r = c.read_head();
                assert_eq!(r.status, 206);
                let mut offset = start;
                while !stop.load(Ordering::Relaxed) && offset < data.len() as u64 {
                    let got = c.read_body(64 * 1024);
                    assert!(!got.is_empty(), "stream ended early");
                    assert!(got[..] == data[offset as usize..offset as usize + got.len()]);
                    offset += got.len() as u64;
                    std::thread::sleep(Duration::from_millis(5));
                }
                // Then the element abandons the request mid-body (a seek), as browsers do.
                drop(c);
            })
        })
        .collect();

    // Many seeks: closed ranges, open-ended ranges abandoned after a little data, suffix
    // ranges, on keep-alive connections, from 24 threads at once.
    let seekers: Vec<_> = (0..24u64)
        .map(|w| {
            let (t, data) = (t.clone(), data.clone());
            std::thread::spawn(move || {
                let mut worst = Duration::ZERO;
                let mut x = w.wrapping_mul(0x2545_F491_4F6C_DD1D) | 1;
                let mut rnd = |n: u64| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    x % n
                };
                let l = data.len() as u64;
                let mut c = Conn::open(addr);
                for i in 0..40u64 {
                    let started = Instant::now();
                    match i % 4 {
                        0 | 1 => {
                            let s = rnd(l);
                            let e = (s + rnd(512 * 1024)).min(l - 1);
                            let h = format!("Range: bytes={s}-{e}");
                            let r = c.request("GET", &t, &[&h]);
                            assert_eq!(r.status, 206);
                            assert_eq!(r.header("content-range").unwrap(), format!("bytes {s}-{e}/{l}"));
                            assert!(r.body[..] == data[s as usize..=e as usize], "bytes {s}-{e}");
                        }
                        2 => {
                            let s = rnd(l);
                            let h = format!("Range: bytes={s}-");
                            c.send("GET", &t, &[&h]);
                            let r = c.read_head();
                            assert_eq!(r.status, 206);
                            let want = (l - s).min(100_000);
                            let got = c.read_body(want);
                            assert!(got[..] == data[s as usize..(s + want) as usize]);
                            // Abandon the rest: open a new connection, like a seek.
                            c = Conn::open(addr);
                        }
                        _ => {
                            let n = 1 + rnd(200_000);
                            let h = format!("Range: bytes=-{n}");
                            let r = c.request("GET", &t, &[&h]);
                            assert_eq!(r.status, 206);
                            assert!(r.body[..] == data[(l - n) as usize..]);
                        }
                    }
                    worst = worst.max(started.elapsed());
                }
                worst
            })
        })
        .collect();

    let mut worst = Duration::ZERO;
    for s in seekers {
        worst = worst.max(s.join().expect("seeker thread"));
    }
    stop.store(true, Ordering::Relaxed);
    for s in streamers {
        s.join().expect("streamer thread");
    }
    eprintln!("960 range requests from 24 threads beside 2 slow streams: slowest {worst:?}");
    assert!(worst < Duration::from_secs(5), "a range request took {worst:?}");

    // The server is still healthy afterwards.
    let r = get(addr, "GET", &t, &["Range: bytes=0-9"]);
    assert_eq!(r.body, data[..10]);
}

#[test]
fn proxy_appearing_is_picked_up() {
    let (server, locator) = start();
    let dir = TempDir::new("appear");
    let t = target(&server, SRC, MediaItem::Proxy);
    assert_eq!(get(server.local_addr(), "GET", &t, &[]).status, 404);
    let p = dir.path("proxy.mp4");
    std::fs::write(&p, b"ready").unwrap();
    locator.set(SRC, MediaItem::Proxy, &p);
    assert_eq!(get(server.local_addr(), "GET", &t, &[]).body, b"ready");
    locator.clear(SRC, MediaItem::Proxy);
    assert_eq!(get(server.local_addr(), "GET", &t, &[]).status, 404);
}

#[test]
fn replacing_a_file_while_it_is_served() {
    let (server, locator) = start();
    let dir = TempDir::new("replace");
    let addr = server.local_addr();
    let t = target(&server, SRC, MediaItem::Proxy);
    let p = dir.path("proxy.mp4");
    let old = pattern(8 * 1024 * 1024, 1);
    let new = pattern(3 * 1024 * 1024, 2);
    std::fs::write(&p, &old).unwrap();
    locator.set(SRC, MediaItem::Proxy, &p);

    // 1. Rename a finished file over the one being served.
    let mut c = Conn::open(addr);
    c.send("GET", &t, &[]);
    let r = c.read_head();
    assert_eq!(r.status, 200);
    let first = c.read_body(1024 * 1024);
    let tmp = dir.path("proxy.mp4.part");
    std::fs::write(&tmp, &new).unwrap();
    std::fs::rename(&tmp, &p).expect("the served file can be replaced");
    let rest = c.read_body(old.len() as u64 - first.len() as u64);
    let mut whole = first;
    whole.extend(rest);
    assert!(whole == old, "the running request keeps reading the file it opened");
    let r = get(addr, "GET", &t, &[]);
    assert!(r.body == new, "new requests get the new file");

    // 2. Delete the file being served.
    let mut c = Conn::open(addr);
    c.send("GET", &t, &["Range: bytes=0-"]);
    assert_eq!(c.read_head().status, 206);
    let first = c.read_body(64 * 1024);
    std::fs::remove_file(&p).expect("the served file can be deleted");
    let rest = c.read_body(new.len() as u64 - first.len() as u64);
    assert_eq!(first.len() + rest.len(), new.len());
    assert_eq!(get(addr, "GET", &t, &[]).status, 404);

    // 3. Truncate it in place while it is served: the response ends short and the
    //    connection closes, and the server carries on.
    std::fs::write(&p, &old).unwrap();
    let mut c = Conn::open(addr);
    c.send("GET", &t, &[]);
    assert_eq!(c.read_head().status, 200);
    let _ = c.read_body(1024);
    {
        let mut f = std::fs::OpenOptions::new().write(true).open(&p).expect("open for writing while served");
        f.set_len(1000).unwrap();
        f.seek(SeekFrom::Start(0)).unwrap();
        f.write_all(&new[..1000]).unwrap();
    }
    let got = c.skip_body(old.len() as u64);
    assert!(got < old.len() as u64 - 1024, "short body expected after truncation, got {got}");
    let r = get(addr, "GET", &t, &[]);
    assert_eq!(r.status, 200);
    assert!(r.body == new[..1000]);
}

/// Marks a new, empty file as sparse, so a 60 GB length costs no disk space.
fn make_sparse(path: &std::path::Path) {
    std::fs::write(path, b"").unwrap();
    #[cfg(windows)]
    {
        let out = std::process::Command::new("fsutil").args(["sparse", "setflag"]).arg(path).output();
        let out = out.expect("fsutil runs");
        assert!(out.status.success(), "fsutil sparse setflag failed: {}", String::from_utf8_lossy(&out.stdout));
    }
}

/// Peak working set of this process in bytes (Windows), via PowerShell.
#[cfg(windows)]
fn peak_working_set() -> u64 {
    let pid = std::process::id();
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("(Get-Process -Id {pid}).PeakWorkingSet64")])
        .output()
        .expect("powershell runs");
    String::from_utf8_lossy(&out.stdout).trim().parse().expect("a number")
}

#[test]
fn sixty_gigabyte_file_is_streamed_not_loaded() {
    let (server, locator) = start();
    let dir = TempDir::new("huge");
    let p = dir.path("original.mov");
    make_sparse(&p);
    let len: u64 = 60 * 1024 * 1024 * 1024;
    let mid = len / 2;
    {
        let mut f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_len(len).unwrap();
        f.seek(SeekFrom::Start(mid)).unwrap();
        f.write_all(b"MIDDLE-MARKER").unwrap();
        f.seek(SeekFrom::Start(len - 10)).unwrap();
        f.write_all(b"END-MARKER").unwrap();
    }
    locator.set(SRC, MediaItem::Original, &p);
    let addr = server.local_addr();
    let t = target(&server, SRC, MediaItem::Original);

    let r = get(addr, "HEAD", &t, &[]);
    assert_eq!(r.status, 200);
    assert_eq!(r.content_length(), Some(len));
    assert_eq!(r.header("content-type"), Some("video/quicktime"));

    let r = get(addr, "GET", &t, &["Range: bytes=-10"]);
    assert_eq!(r.header("content-range"), Some(format!("bytes {}-{}/{len}", len - 10, len - 1).as_str()));
    assert_eq!(r.body, b"END-MARKER");

    let h = format!("Range: bytes={mid}-{}", mid + 12);
    assert_eq!(get(addr, "GET", &t, &[&h]).body, b"MIDDLE-MARKER");

    let h = format!("Range: bytes={len}-");
    assert_eq!(get(addr, "GET", &t, &[&h]).status, 416);

    // A whole-file request answers at once with the full length and streams.
    let started = Instant::now();
    let mut c = Conn::open(addr);
    c.send("GET", &t, &[]);
    let r = c.read_head();
    let head_time = started.elapsed();
    assert_eq!(r.status, 200);
    assert_eq!(r.content_length(), Some(len));
    assert_eq!(c.skip_body(16 * 1024 * 1024), 16 * 1024 * 1024);
    drop(c);
    assert!(head_time < Duration::from_secs(2), "head took {head_time:?}");

    // Stream 2 GiB from the start of the file and check memory stays far below that.
    let chunk: u64 = 2 * 1024 * 1024 * 1024;
    let started = Instant::now();
    let mut c = Conn::open(addr);
    let h = format!("Range: bytes=0-{}", chunk - 1);
    c.send("GET", &t, &[&h]);
    assert_eq!(c.read_head().content_length(), Some(chunk));
    assert_eq!(c.skip_body(chunk), chunk);
    let secs = started.elapsed().as_secs_f64();
    #[cfg(windows)]
    {
        let peak = peak_working_set();
        eprintln!(
            "streamed 2 GiB of a 60 GiB file in {secs:.2} s ({:.0} MB/s); peak working set {} MB",
            chunk as f64 / secs / 1e6,
            peak / 1_000_000
        );
        assert!(peak < 1024 * 1024 * 1024, "peak working set {peak} bytes");
    }
}
