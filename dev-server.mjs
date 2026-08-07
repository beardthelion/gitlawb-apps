// Local dev server: static files plus the same proxy the deployed function uses.
//
//   node dev-server.mjs          then open http://localhost:5173/beat-the-bot/
//
// Routes mirror worker/index.js so a thing that works here works in production.

import { createServer } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { proxyIcaptcha } from "./api/lib/icaptcha-proxy.js";
import { proxyNet } from "./api/lib/net-proxy.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// URL prefix -> directory on disk. Derived from apps/ the same way build.mjs
// derives dist/, so adding an app cannot leave the dev server serving 404s for
// a page that ships fine. lib/ is listed first because the longer prefix has to
// win the match.
const MOUNTS = (await readdir(join(ROOT, "apps"), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .flatMap((e) => [
    [`/${e.name}/lib/`, `apps/${e.name}/lib/`],
    [`/${e.name}/`, `apps/${e.name}/web/`],
  ]);

function resolveStatic(pathname) {
  for (const [prefix, dir] of MOUNTS) {
    if (!pathname.startsWith(prefix)) continue;
    let rest = pathname.slice(prefix.length) || "index.html";
    if (rest.endsWith("/")) rest += "index.html";
    // normalize collapses any ".." before it can escape the mount.
    const rel = normalize(join(dir, rest));
    if (!rel.startsWith(dir)) return null;
    return join(ROOT, rel);
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/ic/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const { status, body } = await proxyIcaptcha(
      url.pathname.slice("/api/ic/".length),
      req.method,
      Buffer.concat(chunks).toString("utf8"),
      process.env.ICAPTCHA_URL,
    );
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // Same module and same 30s cache as the worker, so local and deployed
  // behaviour cannot drift.
  if (url.pathname.startsWith("/api/net/")) {
    const { status, body } = await proxyNet(
      url.pathname.slice("/api/net/".length),
      req.method,
      url.searchParams,
      process.env.NODE_URL,
    );
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(302, { location: "/beat-the-bot/" });
    res.end();
    return;
  }

  const file = resolveStatic(url.pathname);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error("directory");
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}/beat-the-bot/`);
});
