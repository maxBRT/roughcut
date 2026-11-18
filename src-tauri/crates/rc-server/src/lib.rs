//! Roughcut core module `server` (the media server).
//!
//! Responsibility (spec 3.3): Serves proxies, originals and waveforms to the interface over
//! HTTP on this machine only.
//!
//! Public surface: Media endpoints (spec 3.5.6).
//!
//! - Listens on `127.0.0.1` only ([`BIND_IP`]), on a port the system picks at launch.
//! - `GET`/`HEAD /media/{sourceId}/{proxy|original|waveform}?token={token}`. The per-launch
//!   token is read only from the `token` query parameter. Missing or wrong token: 401.
//!   Unknown source, unknown item or an item that is not ready: 404.
//! - Single byte ranges (closed, open-ended, suffix) get 206; an unsatisfiable range gets
//!   416 with `Content-Range: bytes */{len}`; anything else gets the whole file (200).
//!   Bodies are streamed from disk in 256 KiB reads, so file size does not matter.
//! - Every response, including errors and `OPTIONS` preflights, carries
//!   `Access-Control-Allow-Origin: *` and `Cache-Control: no-store` (the player spike found
//!   that cacheable media responses make Chromium hang seeks for seconds).
//! - Files are opened with full sharing, so the media module can replace a proxy that is
//!   being served; the running request keeps reading the file it opened.
//!
//! Where files are comes from the caller through [`MediaLocator`], so this crate depends on
//! nothing but `rc-types`.

mod range;
mod request;
mod serve;

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener as StdListener};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

pub use rc_types::MediaItem;

/// The only address the server binds to: the loopback address, never a wildcard.
pub const BIND_IP: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// Tells the server where a source's files are. Called on a blocking thread for every
/// request, so it may touch the file system, but should be quick.
pub trait MediaLocator: Send + Sync + 'static {
    /// The file for `item` of `source_id`, or `None` when the source is unknown or the item
    /// is not ready yet (both answered with 404).
    fn locate(&self, source_id: &str, item: MediaItem) -> Option<PathBuf>;
}

impl<F> MediaLocator for F
where
    F: Fn(&str, MediaItem) -> Option<PathBuf> + Send + Sync + 'static,
{
    fn locate(&self, source_id: &str, item: MediaItem) -> Option<PathBuf> {
        self(source_id, item)
    }
}

/// The server's base address and token: cheap to clone and send to whoever builds
/// `SourceAssets.playbackUrl` / `waveformUrl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaUrls {
    base: String,
    token: String,
}

impl MediaUrls {
    /// The origin, e.g. `http://127.0.0.1:51234` (no trailing slash).
    pub fn base(&self) -> &str {
        &self.base
    }

    /// The per-launch token.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// The full address of one item, built with `rc_types::media_url`.
    pub fn url(&self, source_id: &str, item: MediaItem) -> String {
        rc_types::media_url(&self.base, &self.token, source_id, item)
    }
}

/// A running media server. Dropping it shuts it down too.
pub struct MediaServer {
    urls: MediaUrls,
    addr: SocketAddr,
    stop: Option<tokio::sync::watch::Sender<bool>>,
    thread: Option<JoinHandle<()>>,
}

impl MediaServer {
    /// Binds `127.0.0.1:0`, creates a fresh random token and starts serving on a background
    /// thread with its own runtime. Safe to call from inside or outside an async runtime.
    pub fn start(locator: Arc<dyn MediaLocator>) -> io::Result<MediaServer> {
        let token = request::new_token()?;
        let (listener, addr) = bind_loopback()?;
        let shared = Arc::new(serve::Shared { token: token.clone(), locator });
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<io::Result<()>>();

        let thread = std::thread::Builder::new().name("rc-server".into()).spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .max_blocking_threads(64)
                .thread_name("rc-server-worker")
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => {
                        let _ = ready_tx.send(Ok(()));
                        l
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                accept_loop(listener, shared, stop_rx).await;
            });
            // Drops every open connection; waits briefly for file reads in flight.
            runtime.shutdown_timeout(Duration::from_secs(2));
        })?;

        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = thread.join();
                return Err(e);
            }
            Err(_) => {
                let _ = thread.join();
                return Err(io::Error::other("media server thread ended during start"));
            }
        }

        Ok(MediaServer {
            urls: MediaUrls { base: format!("http://{addr}"), token },
            addr,
            stop: Some(stop_tx),
            thread: Some(thread),
        })
    }

    /// The origin, e.g. `http://127.0.0.1:51234`.
    pub fn base(&self) -> &str {
        self.urls.base()
    }

    /// The per-launch token.
    pub fn token(&self) -> &str {
        self.urls.token()
    }

    /// The bound socket address (always on `127.0.0.1`).
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The base address and token, to build addresses elsewhere.
    pub fn urls(&self) -> MediaUrls {
        self.urls.clone()
    }

    /// The full address of one item, built with `rc_types::media_url`.
    pub fn url(&self, source_id: &str, item: MediaItem) -> String {
        self.urls.url(source_id, item)
    }

    /// Stops listening, closes every connection and waits for the server thread to end.
    pub fn shutdown(mut self) {
        self.stop_and_join();
    }

    fn stop_and_join(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(true);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for MediaServer {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

impl std::fmt::Debug for MediaServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaServer").field("addr", &self.addr).finish_non_exhaustive()
    }
}

/// The address the listener binds: always `127.0.0.1` with port 0 (the system picks one).
fn bind_address() -> SocketAddrV4 {
    SocketAddrV4::new(BIND_IP, 0)
}

/// Binds the listener to [`bind_address`] and checks that the socket really is on the
/// loopback address before anything is served.
fn bind_loopback() -> io::Result<(StdListener, SocketAddr)> {
    let listener = StdListener::bind(bind_address())?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    if addr.ip() != IpAddr::V4(BIND_IP) {
        return Err(io::Error::other(format!("media server bound to {addr}, not the loopback address")));
    }
    Ok((listener, addr))
}

async fn accept_loop(
    listener: tokio::net::TcpListener,
    shared: Arc<serve::Shared>,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        // Defence in depth: only loopback peers can reach a loopback socket.
                        if !peer.ip().is_loopback() {
                            continue;
                        }
                        tokio::spawn(serve::connection(stream, Arc::clone(&shared)));
                    }
                    // Transient accept errors (for example too many open handles): back off.
                    Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_the_loopback_address_explicitly() {
        assert_eq!(BIND_IP, Ipv4Addr::new(127, 0, 0, 1));
        let addr = bind_address();
        assert_eq!(*addr.ip(), Ipv4Addr::LOCALHOST);
        assert!(!addr.ip().is_unspecified());
        assert_eq!(addr.port(), 0, "the system picks the port");
        let (listener, bound) = bind_loopback().unwrap();
        assert_eq!(bound.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(bound.port(), 0);
        assert_eq!(listener.local_addr().unwrap(), bound);
    }
}
