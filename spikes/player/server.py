"""Player spike: a tiny local HTTP server with byte-range support.

  python server.py [port] [--cap-mb N] [--log file] [--media-cache VALUE]   (default 8765, binds 127.0.0.1 only)

  GET  /                -> index.html (the prototype player)
  GET  /<file>          -> files in spikes/player/
  GET  /media/<file>    -> files in .cache-dev/player/ (Range requests -> 206)
  POST /results/<name>  -> body saved as spikes/player/results/<name>.json
  GET  /quit            -> stops the server (used by the test runner)
"""
import os, re, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.abspath(os.path.join(HERE, "..", "..", ".cache-dev", "player"))
RESULTS = os.path.join(HERE, "results")
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".json": "application/json", ".mp4": "video/mp4"}
CHUNK = 1 << 20
CAP = 0          # bytes; set from --cap-mb
LOG = None       # file for a request log, set from --log
MEDIA_CACHE = "no-store"   # --media-cache "max-age=3600" reproduces the stalls
OPEN = 0         # responses currently being written (for the log)
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet: range requests are very chatty
        pass

    def _resolve(self, path):
        path = path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        if path.startswith("/media/"):
            base, rel = MEDIA, path[len("/media/"):]
        else:
            base, rel = HERE, path.lstrip("/")
        full = os.path.abspath(os.path.join(base, rel))
        if not full.startswith(base + os.sep) or not os.path.isfile(full):
            return None
        return full

    def do_GET(self):
        if self.path == "/quit":
            self._send_simple(200, b"bye")
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        full = self._resolve(self.path)
        if not full:
            return self._send_simple(404, b"not found")
        size = os.path.getsize(full)
        ctype = TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if not m or (m.group(1) == "" and m.group(2) == ""):
                return self._send_simple(416, b"bad range", {"Content-Range": f"bytes */{size}"})
            if m.group(1) == "":                       # suffix range: last N bytes
                start = max(0, size - int(m.group(2)))
            else:
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                elif CAP:
                    # Open-ended range ("bytes=X-"): answer with at most CAP bytes. The browser asks
                    # again for the rest. Without this every <video> holds a connection streaming
                    # the whole file, and seeks of the second element wait for a free connection.
                    end = min(size - 1, start + CAP - 1)
            if start >= size or start > end:
                return self._send_simple(416, b"bad range", {"Content-Range": f"bytes */{size}"})
            status = 206
        length = end - start + 1
        global OPEN
        rid = id(self) % 100000
        with LOCK:
            OPEN += 1
            if LOG:
                LOG.write(f"{time.perf_counter():.3f} start #{rid} open={OPEN} {self.path} {rng or '-'} -> {start}-{end}\n"); LOG.flush()
        t0, sent, how = time.perf_counter(), 0, "done"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        # Media MUST be no-store. With a cacheable response Chromium's HTTP cache lets only one
        # request per URL write the cache entry at a time; the second <video>'s range request then
        # waits for the first one's streaming response to end (seen as 2-18 s seek stalls).
        self.send_header("Cache-Control", "no-store" if ctype.startswith("text/") else MEDIA_CACHE)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(full, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    buf = f.read(min(CHUNK, left))
                    if not buf:
                        break
                    self.wfile.write(buf)
                    left -= len(buf)
                    sent += len(buf)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            how = "aborted"  # the browser cancels range requests all the time when seeking
        finally:
            with LOCK:
                OPEN -= 1
                if LOG:
                    LOG.write(f"{time.perf_counter():.3f} {how}  #{rid} open={OPEN} sent={sent} in {time.perf_counter() - t0:.2f}s\n"); LOG.flush()

    def do_POST(self):
        m = re.match(r"^/results/([\w.-]+)$", self.path)
        if not m:
            return self._send_simple(404, b"not found")
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        os.makedirs(RESULTS, exist_ok=True)
        with open(os.path.join(RESULTS, m.group(1) + ".json"), "wb") as f:
            f.write(body)
        print("saved result", m.group(1), len(body), "bytes", flush=True)
        self._send_simple(200, b"ok")

    def _send_simple(self, code, body, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], ConnectionError):
            return  # browser closed a range request early: normal while seeking
        super().handle_error(request, client_address)


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--cap-mb" in args:
        i = args.index("--cap-mb"); CAP = int(float(args[i + 1]) * (1 << 20)); del args[i:i + 2]
    if "--log" in args:
        i = args.index("--log"); LOG = open(args[i + 1], "a"); del args[i:i + 2]
    if "--media-cache" in args:
        i = args.index("--media-cache"); MEDIA_CACHE = args[i + 1]; del args[i:i + 2]
    port = int(args[0]) if args else 8765
    srv = Server(("127.0.0.1", port), Handler)
    print(f"serving http://127.0.0.1:{port}/  media from {MEDIA}", flush=True)
    srv.serve_forever()
