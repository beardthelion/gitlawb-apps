// Same-origin proxy to the iCaptcha service.
//
// It exists because icaptcha.gitlawb.com sends no CORS headers and answers
// OPTIONS with 405, so the browser blocks a direct call before it leaves the tab.
//
// Deliberately an allowlist of two routes, not a general forwarder. An open proxy
// on a public URL is someone else's traffic laundering service.

// The upstream is passed in rather than read from an ambient global, because
// this module runs in both node and the Workers runtime and Workers has no
// `process`. Reading process.env at module scope crashed the worker on startup.
export const DEFAULT_UPSTREAM = "https://icaptcha.gitlawb.com";

const ALLOWED = new Set(["v1/challenge", "v1/answer"]);

// The upstream bodies are small and fixed-shape. Anything larger is not a real
// player, and reading it would just be free memory for whoever sent it.
const MAX_BODY = 8 * 1024;

/**
 * Handle a proxied request. `path` is the upstream path with no leading slash,
 * e.g. "v1/answer". Returns {status, body} with body already JSON-encodable.
 */
export async function proxyIcaptcha(path, method, rawBody, upstream = DEFAULT_UPSTREAM) {
  if (method !== "POST") {
    return { status: 405, body: { error: "method not allowed" } };
  }
  if (!ALLOWED.has(path)) {
    return { status: 404, body: { error: "not found" } };
  }
  if (rawBody && rawBody.length > MAX_BODY) {
    return { status: 413, body: { error: "body too large" } };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }

  // How long upstream took is measured here, on the server, and returned so the
  // caller can subtract it from a run's score. The client never reports it.
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  try {
    const res = await fetch(`${upstream}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text), upstreamMs: elapsed() };
    } catch {
      // Upstream returned something that is not JSON. Do not pass its bytes
      // through verbatim; report the shape of the failure instead.
      return { status: 502, body: { error: "upstream returned non-json" }, upstreamMs: elapsed() };
    }
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    // A timeout is the gate's slowest possible answer, so it still counts as
    // gate time; the run is usually lost anyway, but the accounting stays honest.
    return {
      status: timedOut ? 504 : 502,
      body: { error: timedOut ? "upstream timed out" : "upstream unreachable" },
      upstreamMs: elapsed(),
    };
  }
}
