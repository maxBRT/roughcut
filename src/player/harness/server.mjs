// Harness servers (measurement only), bound to 127.0.0.1:
//   page server  :PAGE   the built harness page, audio-tap.js, POST /results/<name>, GET /quit
//   media server :MEDIA  /media/{A|B}/{proxy|original}?token=harness, shaped like the core's
//                        media server (spec 3.5.6): token in the query (401 without), 404 for an
//                        unknown item, byte ranges (206), Access-Control-Allow-Origin: * on every
//                        response and preflight, and Cache-Control: no-store (the experiment's
//                        condition 1).
// Usage: node server.mjs <distDir> <resultsDir> <mediaJson> [pagePort] [mediaPort]
import { appendFileSync, createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [distDir, resultsDir, mediaJson, pagePort = "8771", mediaPort = "8772"] = process.argv.slice(2);
const MEDIA = JSON.parse(mediaJson); // { "A/proxy": "path", ... }
const TOKEN = "harness";
// Request log of the media server (open responses), for diagnosing slow seeks.
const LOG = process.env.HARNESS_MEDIA_LOG;
let open = 0;
const t0 = Date.now();
const note = (s) => LOG && appendFileSync(LOG, `${((Date.now() - t0) / 1000).toFixed(3)} open=${open} ${s}
`);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".map": "application/json" };

function sendFile(req, res, file, type, extraHeaders) {
  const size = statSync(file).size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      res.writeHead(416, { ...extraHeaders, "Content-Range": `bytes */${size}` });
      return res.end();
    }
    if (m[1] === "") start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      res.writeHead(416, { ...extraHeaders, "Content-Range": `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const headers = { ...extraHeaders, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1) };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file, { start, end });
  stream.pipe(res);
  res.on("close", () => stream.destroy());
}

const page = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const plain = { "Cache-Control": "no-store" };
  if (url.pathname === "/quit") {
    res.writeHead(200, plain);
    res.end("bye");
    setTimeout(() => process.exit(0), 50);
    return;
  }
  const m = /^\/results\/([\w.-]+)$/.exec(url.pathname);
  if (req.method === "POST" && m) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, `${m[1]}.json`), Buffer.concat(chunks));
      console.log(`saved ${m[1]} (${Buffer.concat(chunks).length} bytes)`);
      res.writeHead(200, plain);
      res.end("ok");
    });
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  for (const base of [resolve(distDir), HERE]) {
    const file = normalize(join(base, rel));
    if (!file.startsWith(base)) continue;
    try {
      if (statSync(file).isFile()) return sendFile(req, res, file, TYPES[extname(file)] ?? "application/octet-stream", plain);
    } catch {
      /* try the next folder */
    }
  }
  res.writeHead(404, plain);
  res.end("not found");
});

const media = createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" });
    return res.end();
  }
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.searchParams.get("token") !== TOKEN) {
    res.writeHead(401, cors);
    return res.end("no token");
  }
  const m = /^\/media\/([^/]+)\/(proxy|original)$/.exec(url.pathname);
  const file = m ? MEDIA[`${decodeURIComponent(m[1])}/${m[2]}`] : undefined;
  if (!file) {
    res.writeHead(404, cors);
    return res.end("unknown");
  }
  open++;
  note(`start ${url.pathname} ${req.headers.range ?? "-"}`);
  res.on("close", () => {
    open--;
    note(`close ${url.pathname} ${req.headers.range ?? "-"} sent=${res.writableFinished ? "all" : "part"}`);
  });
  sendFile(req, res, file, "video/mp4", cors);
});

page.listen(Number(pagePort), "127.0.0.1", () => console.log(`page  http://127.0.0.1:${pagePort}/`));
media.listen(Number(mediaPort), "127.0.0.1", () => console.log(`media http://127.0.0.1:${mediaPort}/`));
