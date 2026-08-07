// Same-origin proxy to the Gitlawb node, for the Push Wall's live layer.
//
// It exists because node.gitlawb.com sends no CORS headers, so a poll from the
// page is blocked before it leaves the tab. Same shape as icaptcha-proxy.js.
//
// Deliberately an allowlist of four routes, not a general forwarder. An open
// proxy on a public URL is someone else's traffic laundering service.
//
// /api/v1/agents is not on the list and must not be added: it returns all 4,088
// agents in one ~960KB response, and the live layer has no use for it. Putting
// it here would mean a 960KB upstream fetch on every cache miss.

// The upstream is passed in rather than read from an ambient global, because
// this module runs in both node and the Workers runtime and Workers has no
// `process`. Reading process.env at module scope crashed the worker on startup.
export const DEFAULT_UPSTREAM = "https://node.gitlawb.com";

// Caller-facing path -> what the node actually gets asked. `limit` is the only
// caller input that reaches upstream, and only through the bounds below; the
// caller's query string itself is never forwarded.
const ROUTES = {
  "stats": { path: "api/v1/stats" },
  "peers": { path: "api/v1/peers" },
  // Ordered by updated_at descending, so page 1 alone answers "what just moved".
  // 200 is the whole live view; there is no paging and no offset parameter here.
  "repos": { path: "api/v1/repos", limit: { default: 200, max: 200 } },
  // The node records about 0.5 pushes per minute, so 50 events is roughly the
  // last day and a half of activity. 200 is the ceiling, not a target.
  "events/ref-updates": { path: "api/v1/events/ref-updates", limit: { default: 50, max: 200 } },
};

// The largest allowlisted response is repos?limit=200, measured at 100,546 bytes.
// Anything past this is not a shape this proxy knows how to serve.
const MAX_BODY = 512 * 1024;

const TIMEOUT_MS = 8_000;

// About one poll interval. The node must not receive one request per visitor,
// and at 0.5 pushes per minute a 30s-stale answer is indistinguishable from a
// fresh one: a 7-minute poll at 30s intervals saw the counter move in only 1 of
// 13 intervals.
//
// Honest scope: this Map lives in a Workers isolate, which is per-colo and
// short-lived. It bounds what one isolate asks of the node, not what the node
// receives globally. Traffic spread over several colos, or arriving after an
// isolate is recycled, still reaches upstream. That is a real limit of this
// design; a global bound would need Cache API or a Durable Object.
export const CACHE_MS = 30_000;

const cache = new Map();

/** Drop every cached entry. Exists for the tests; nothing in the request path calls it. */
export function clearNetCache() {
  cache.clear();
}

// Garbage, negatives and out-of-range all resolve to a number inside the bounds
// rather than reaching upstream. The node has no per-caller quota of its own, so
// an unbounded `limit` here would be an unbounded fetch there.
function clampLimit(raw, bounds) {
  // Number("") is 0, not NaN, so an empty ?limit= would otherwise clamp to 1
  // and silently serve a one-row page instead of the default.
  if (raw === null || raw === undefined || String(raw).trim() === "") return bounds.default;
  const n = Number(raw);
  if (!Number.isFinite(n)) return bounds.default;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > bounds.max) return bounds.max;
  return floored;
}

// The page needs "what just moved", which is a name, an owner and a timestamp.
// Dropping description and clone_url takes the 200-row payload from 100,546
// bytes to 32,278, measured against the live node; clone_url is reconstructible
// from owner_did and name.
function trimRepos(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    name: r?.name ?? null,
    owner: r?.owner_did ?? null,
    updated_at: r?.updated_at ?? null,
    stars: r?.star_count ?? 0,
  }));
}

// old_sha, node_did, from_peer, cert_id and received_at are replication
// bookkeeping, not push-wall content. owner_did is dropped too because `repo` is
// already "<owner_did>/<name>". new_sha is cut to the 12 characters a UI shows.
function trimEvents(body) {
  const events = Array.isArray(body?.events) ? body.events : [];
  return {
    count: events.length,
    events: events.map((e) => ({
      repo: e?.repo ?? null,
      ref: e?.ref_name ?? null,
      sha: typeof e?.new_sha === "string" ? e.new_sha.slice(0, 12) : null,
      pusher: e?.pusher_did ?? null,
      timestamp: e?.timestamp ?? null,
    })),
  };
}

// Peers are already four small fields per row and all four are shown, so there
// is nothing worth trimming. `reachable` is counted here so the page does not
// have to walk the array to render one number.
function trimPeers(body) {
  const peers = Array.isArray(body?.peers) ? body.peers : [];
  return {
    count: body?.count ?? peers.length,
    reachable: peers.filter((p) => p?.reachable === true).length,
    peers,
  };
}

const SHAPERS = {
  "stats": (body) => body,
  "peers": trimPeers,
  "repos": trimRepos,
  "events/ref-updates": trimEvents,
};

/**
 * Handle a proxied request. `path` is the caller-facing path with no leading
 * slash, e.g. "events/ref-updates". `params` is anything with a .get(name)
 * (a URLSearchParams); only "limit" is ever read from it. Returns {status, body}
 * with body already JSON-encodable.
 */
export async function proxyNet(path, method, params, upstream = DEFAULT_UPSTREAM, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  if (method !== "GET") {
    return { status: 405, body: { error: "method not allowed" } };
  }

  // Exact match against the allowlist keys. Every escape attempt fails here for
  // the same reason: "../api/v1/agents", "//evil.example", "https://evil/x",
  // "repos?limit=9999" and "stats%2f.." are none of them equal to a key.
  const route = Object.prototype.hasOwnProperty.call(ROUTES, path) ? ROUTES[path] : null;
  if (!route) {
    return { status: 404, body: { error: "not found" } };
  }

  let target = route.path;
  if (route.limit) {
    target += `?limit=${clampLimit(params?.get?.("limit"), route.limit)}`;
  }

  const hit = cache.get(target);
  if (hit && hit.expires > now()) {
    return { status: hit.status, body: hit.body, cached: true };
  }

  const result = await fetchUpstream(doFetch, `${upstream}/${target}`, path);
  // Failures are cached too. A node that is down or slow is exactly when it
  // must not also take one request per visitor, and the page polls again in
  // 30s anyway, so the shaped error costs at most one stale interval.
  cache.set(target, { status: result.status, body: result.body, expires: now() + CACHE_MS });
  return { ...result, cached: false };
}

async function fetchUpstream(doFetch, url, path) {
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (text.length > MAX_BODY) {
      return { status: 502, body: { error: "upstream response too large" } };
    }
    if (!res.ok) {
      // Upstream bytes are not passed through on a failure: the node's error
      // pages are not JSON and are not this proxy's contract.
      return { status: 502, body: { error: `upstream returned ${res.status}` } };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: 502, body: { error: "upstream returned non-json" } };
    }
    return { status: 200, body: SHAPERS[path](parsed) };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      status: timedOut ? 504 : 502,
      body: { error: timedOut ? "upstream timed out" : "upstream unreachable" },
    };
  }
}
