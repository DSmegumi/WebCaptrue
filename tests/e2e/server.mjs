import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function serveFile(req, res, baseRoot = root) {
  const url = new URL(req.url, "http://127.0.0.1");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(baseRoot, requested);
  if (!file.startsWith(baseRoot) || !fs.existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}

const main = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8765");
  if (url.pathname === "/api/items") {
    if (req.headers.origin === "http://127.0.0.1:8766") res.setHeader("access-control-allow-origin", req.headers.origin);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items: [{ id: 42, name: "sample" }], token: "fixture-secret" }));
    return;
  }
  if (url.pathname === "/api/submit" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, received: JSON.parse(body) }));
    });
    return;
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("event: ready\ndata: {\"status\":\"connected\"}\n\n");
    setTimeout(() => res.end(), 5000);
    return;
  }
  serveFile(req, res);
});

main.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") return socket.destroy();
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const payload = Buffer.from(JSON.stringify({ type: "server-ready", token: "fixture-ws-secret" }));
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  setTimeout(() => socket.end(), 1500);
});

const crossOrigin = http.createServer((req, res) => {
  if (req.url === "/cross-frame.html") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><title>Cross origin frame</title><button id="cross-fetch">跨源 iframe 请求</button><script>document.querySelector("#cross-fetch").onclick=()=>fetch("http://127.0.0.1:8765/api/items?from=oopif")</script>');
    return;
  }
  res.writeHead(404).end("not found");
});

main.listen(8765, "127.0.0.1", () => console.log("fixture=http://127.0.0.1:8765"));
crossOrigin.listen(8766, "127.0.0.1", () => console.log("cross-origin=http://127.0.0.1:8766/cross-frame.html"));

function shutdown() {
  main.close();
  crossOrigin.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
