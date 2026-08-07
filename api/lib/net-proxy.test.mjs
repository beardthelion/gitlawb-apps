// The proxy is a public network surface, so this suite is written to break it,
// not to confirm it works. The escape attempts, the method rejections and the
// upstream failure modes come first; the four happy paths are last, so a change
// that turns the allowlist into a forwarder shows up as the rejections failing
// rather than being hidden behind a green 200.
//
// Upstream is an injected counting fake, so nothing here touches the network and
// CI does not depend on node.gitlawb.com being reachable.

import { proxyNet, clearNetCache, CACHE_MS } from "./net-proxy.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const UP = "https://node.example";

const REPO_ROW = {
  id: "1d83e0d4", name: "minebean-nostradamus",
  owner_did: "did:key:zOWNER", description: "a long description that the page never renders",
  is_public: true, default_branch: "main",
  clone_url: "https://node.example/zOWNER/minebean-nostradamus.git",
  star_count: 3, created_at: "2026-05-25T04:46:06Z",
  updated_at: "2026-08-07T14:30:45Z", forked_from: null,
};
const EVENT_ROW = {
  cert_id: null, from_peer: "http:did:key:zPEER", id: "acd7ef74",
  new_sha: "df4830cc246b62d780f45bcc38be404d095a4438", node_did: "did:key:zNODE",
  old_sha: "0".repeat(40), owner_did: "did:key:zOWNER", pusher_did: "did:key:zPUSHER",
  received_at: "2026-08-05T16:32:24Z", ref_name: "refs/heads/main",
  repo: "zOWNER/propagation-icaptcha", timestamp: "2026-08-05T16:32:24Z",
};

const BODIES = {
  "api/v1/stats": { agents: 4088, pushes: 44059, repos: 3150, version: "0.7.0" },
  "api/v1/peers": {
    count: 2,
    peers: [
      { did: "did:key:zA", http_url: "https://a.example", last_seen: "2026-08-07T14:30:43Z", reachable: true },
      { did: "did:key:zB", http_url: "https://b.example", last_seen: "2026-08-07T14:30:43Z", reachable: false },
    ],
  },
  "api/v1/repos": [REPO_ROW],
  "api/v1/events/ref-updates": { count: 1, events: [EVENT_ROW] },
};

// Records every URL it is asked for, so "did this reach upstream" and "what
// exactly did upstream get asked" are both observed rather than assumed.
function fakeUpstream(over = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (over.throw) throw over.throw;
    const key = new URL(url).pathname.slice(1);
    if (over.status && over.status !== 200) {
      return { ok: false, status: over.status, text: async () => "<html>gateway error</html>" };
    }
    if (over.nonJson) {
      return { ok: true, status: 200, text: async () => "<html>not json at all</html>" };
    }
    if (over.huge) {
      return { ok: true, status: 200, text: async () => "x".repeat(600 * 1024) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(BODIES[key]) };
  };
  return { fn, calls };
}

const get = (path, params, deps) =>
  proxyNet(path, "GET", params ? new URLSearchParams(params) : null, UP, deps);

// --- the allowlist -------------------------------------------------------
// Everything here must 404 without a single upstream call. The second number in
// each check is the call count, because a 404 that still hit the node would mean
// the proxy forwarded first and judged afterwards.
{
  const denied = [
    ["agents is not proxied", "api/v1/agents"],
    ["bare agents", "agents"],
    ["dot-dot escape", "../api/v1/agents"],
    ["dot-dot from an allowed prefix", "repos/../../api/v1/agents"],
    ["absolute https url", "https://evil.example/steal"],
    ["absolute http url", "http://evil.example/steal"],
    ["protocol relative", "//evil.example"],
    ["protocol relative with path", "//evil.example/api/v1/stats"],
    ["query smuggled into the path", "repos?limit=9999"],
    ["query smuggled onto stats", "stats?x=1"],
    ["percent encoded traversal", "%2e%2e%2fapi%2fv1%2fagents"],
    ["percent encoded slash", "repos%2f..%2f..%2fapi%2fv1%2fagents"],
    ["trailing slash is not the route", "stats/"],
    ["leading slash is not the route", "/stats"],
    ["case is not the route", "Stats"],
    ["empty path", ""],
    ["prototype key", "constructor"],
    ["prototype chain key", "__proto__"],
    ["toString", "toString"],
    ["events parent is not a route", "events"],
    ["repos with an id", "repos/1d83e0d4"],
  ];
  for (const [name, path] of denied) {
    clearNetCache();
    const up = fakeUpstream();
    const r = await get(path, null, { fetch: up.fn });
    check(`404: ${name}`, r.status, 404);
    check(`404 without an upstream call: ${name}`, up.calls.length, 0);
  }
}

// --- method ---------------------------------------------------------------
for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "get"]) {
  clearNetCache();
  const up = fakeUpstream();
  const r = await proxyNet("stats", method, null, UP, { fetch: up.fn });
  check(`405: ${method}`, r.status, 405);
  check(`405 without an upstream call: ${method}`, up.calls.length, 0);
}

// --- limit bounds ---------------------------------------------------------
// The caller's query string never reaches upstream. Only a clamped `limit` does,
// which is why each of these asserts the exact URL the node was asked for.
{
  const cases = [
    ["repos default when absent", "repos", null, "api/v1/repos?limit=200"],
    ["repos limit passes through in range", "repos", { limit: "20" }, "api/v1/repos?limit=20"],
    ["repos limit clamped to max", "repos", { limit: "100000" }, "api/v1/repos?limit=200"],
    ["repos negative limit clamped to 1", "repos", { limit: "-5" }, "api/v1/repos?limit=1"],
    ["repos zero clamped to 1", "repos", { limit: "0" }, "api/v1/repos?limit=1"],
    ["repos non-numeric falls back to default", "repos", { limit: "abc" }, "api/v1/repos?limit=200"],
    ["repos empty limit falls back to default", "repos", { limit: "" }, "api/v1/repos?limit=200"],
    ["repos float floored", "repos", { limit: "12.9" }, "api/v1/repos?limit=12"],
    ["repos Infinity falls back to default", "repos", { limit: "Infinity" }, "api/v1/repos?limit=200"],
    ["repos NaN falls back to default", "repos", { limit: "NaN" }, "api/v1/repos?limit=200"],
    ["repos hex is not a smuggled string", "repos", { limit: "0x10" }, "api/v1/repos?limit=16"],
    ["repos injection attempt in limit", "repos", { limit: "1&offset=99" }, "api/v1/repos?limit=200"],
    ["events default when absent", "events/ref-updates", null, "api/v1/events/ref-updates?limit=50"],
    ["events limit clamped to max", "events/ref-updates", { limit: "5000" }, "api/v1/events/ref-updates?limit=200"],
    ["events negative clamped to 1", "events/ref-updates", { limit: "-1" }, "api/v1/events/ref-updates?limit=1"],
    ["stats ignores limit entirely", "stats", { limit: "500" }, "api/v1/stats"],
    ["peers ignores limit entirely", "peers", { limit: "500" }, "api/v1/peers"],
  ];
  for (const [name, path, params, want] of cases) {
    clearNetCache();
    const up = fakeUpstream();
    await get(path, params, { fetch: up.fn });
    check(`upstream url: ${name}`, up.calls[0], `${UP}/${want}`);
  }

  // A whole extra query string, not just an extra limit. None of it may travel.
  clearNetCache();
  const up = fakeUpstream();
  await get("repos", { limit: "10", offset: "500", sort: "stars", callback: "evil" }, { fetch: up.fn });
  check("no caller query string reaches upstream", up.calls[0], `${UP}/api/v1/repos?limit=10`);
}

// --- the cache ------------------------------------------------------------
// Counted upstream calls with an injected clock, never a real request and a
// stopwatch. The cache is the reason this module exists: without it the node
// takes one request per visitor per poll.
{
  clearNetCache();
  const up = fakeUpstream();
  let clock = 1_000_000;
  const deps = { fetch: up.fn, now: () => clock };

  const first = await get("stats", null, deps);
  check("cache: first call is a miss", first.cached, false);
  check("cache: first call hit upstream once", up.calls.length, 1);

  clock += 1_000;
  const second = await get("stats", null, deps);
  check("cache: second call inside the window is a hit", second.cached, true);
  check("cache: second call made no upstream call", up.calls.length, 1);
  check("cache: hit returns the same body", JSON.stringify(second.body), JSON.stringify(first.body));

  clock += CACHE_MS - 1_001;
  await get("stats", null, deps);
  check("cache: still cached one ms before expiry", up.calls.length, 1);

  clock += 2;
  const third = await get("stats", null, deps);
  check("cache: expired entry refetches", up.calls.length, 2);
  check("cache: refetch is reported as a miss", third.cached, false);

  // Keyed by the resolved upstream path, so a different limit is a different
  // entry and must not be served the first one's rows.
  const reposA = await get("repos", { limit: "10" }, deps);
  check("cache: a new key misses", reposA.cached, false);
  check("cache: a new key fetches", up.calls.length, 3);
  const reposB = await get("repos", { limit: "20" }, deps);
  check("cache: a different limit is a different key", reposB.cached, false);
  check("cache: a different limit fetches again", up.calls.length, 4);
  const reposC = await get("repos", { limit: "10" }, deps);
  check("cache: the first limit is still cached", reposC.cached, true);
  check("cache: no fifth call", up.calls.length, 4);

  // Two limits that clamp to the same number share one entry, because the key is
  // what upstream was asked, not what the caller typed.
  const clampA = await get("repos", { limit: "5000" }, deps);
  check("cache: clamped limit misses once", clampA.cached, false);
  const clampB = await get("repos", { limit: "99999" }, deps);
  check("cache: a different oversized limit hits the same entry", clampB.cached, true);
}

// --- upstream failure modes ----------------------------------------------
// Each one must produce a shaped error. None may pass upstream bytes through or
// throw out of the proxy.
{
  clearNetCache();
  const up = fakeUpstream({ nonJson: true });
  const r = await get("stats", null, { fetch: up.fn });
  check("non-json upstream: status", r.status, 502);
  check("non-json upstream: shaped error", r.body.error, "upstream returned non-json");
  check("non-json upstream: no bytes passed through", JSON.stringify(r.body).includes("<html>"), false);
}
{
  clearNetCache();
  const up = fakeUpstream({ status: 500 });
  const r = await get("repos", null, { fetch: up.fn });
  check("upstream 500: status", r.status, 502);
  check("upstream 500: shaped error", r.body.error, "upstream returned 500");
  check("upstream 500: no bytes passed through", JSON.stringify(r.body).includes("gateway error"), false);
}
{
  clearNetCache();
  const up = fakeUpstream({ status: 404 });
  const r = await get("peers", null, { fetch: up.fn });
  check("upstream 404: becomes 502, not a proxied 404", r.status, 502);
  check("upstream 404: shaped error", r.body.error, "upstream returned 404");
}
{
  clearNetCache();
  const err = new Error("timed out");
  err.name = "TimeoutError";
  const up = fakeUpstream({ throw: err });
  const r = await get("stats", null, { fetch: up.fn });
  check("timeout: status", r.status, 504);
  check("timeout: shaped error", r.body.error, "upstream timed out");
}
{
  clearNetCache();
  const err = new Error("aborted");
  err.name = "AbortError";
  const up = fakeUpstream({ throw: err });
  const r = await get("stats", null, { fetch: up.fn });
  check("abort: status", r.status, 504);
}
{
  clearNetCache();
  const up = fakeUpstream({ throw: new TypeError("fetch failed") });
  const r = await get("stats", null, { fetch: up.fn });
  check("unreachable: status", r.status, 502);
  check("unreachable: shaped error", r.body.error, "upstream unreachable");
}
{
  clearNetCache();
  const up = fakeUpstream({ huge: true });
  const r = await get("repos", null, { fetch: up.fn });
  check("oversized upstream body: status", r.status, 502);
  check("oversized upstream body: shaped error", r.body.error, "upstream response too large");
}
{
  // Valid JSON of the wrong shape. The trimmers must not throw on it.
  clearNetCache();
  const up = { calls: [], fn: async () => ({ ok: true, status: 200, text: async () => "null" }) };
  const r = await get("repos", null, { fetch: up.fn });
  check("null json for repos: does not throw", r.status, 200);
  check("null json for repos: empty array", JSON.stringify(r.body), "[]");
}
{
  clearNetCache();
  const fn = async () => ({ ok: true, status: 200, text: async () => '{"events":"nope"}' });
  const r = await get("events/ref-updates", null, { fetch: fn });
  check("events wrong type: does not throw", r.status, 200);
  check("events wrong type: empty list", r.body.events.length, 0);
}

// --- the happy paths, last ------------------------------------------------
{
  clearNetCache();
  const up = fakeUpstream();
  const r = await get("stats", null, { fetch: up.fn });
  check("stats: 200", r.status, 200);
  check("stats: pushes", r.body.pushes, 44059);
  check("stats: version", r.body.version, "0.7.0");
}
{
  clearNetCache();
  const up = fakeUpstream();
  const r = await get("peers", null, { fetch: up.fn });
  check("peers: 200", r.status, 200);
  check("peers: count", r.body.count, 2);
  check("peers: reachable counted server side", r.body.reachable, 1);
  check("peers: rows kept", r.body.peers.length, 2);
}
{
  clearNetCache();
  const up = fakeUpstream();
  const r = await get("repos", null, { fetch: up.fn });
  check("repos: 200", r.status, 200);
  check("repos: is an array", Array.isArray(r.body), true);
  check("repos: name", r.body[0].name, "minebean-nostradamus");
  check("repos: owner", r.body[0].owner, "did:key:zOWNER");
  check("repos: updated_at", r.body[0].updated_at, "2026-08-07T14:30:45Z");
  check("repos: stars", r.body[0].stars, 3);
  // The trim is the payload budget, so assert the dropped fields are gone
  // rather than only that the kept ones are present.
  check("repos: description dropped", "description" in r.body[0], false);
  check("repos: clone_url dropped", "clone_url" in r.body[0], false);
  check("repos: id dropped", "id" in r.body[0], false);
  check("repos: created_at dropped", "created_at" in r.body[0], false);
  check("repos: field count", Object.keys(r.body[0]).length, 4);
}
{
  clearNetCache();
  const up = fakeUpstream();
  const r = await get("events/ref-updates", null, { fetch: up.fn });
  check("events: 200", r.status, 200);
  check("events: count", r.body.count, 1);
  check("events: repo", r.body.events[0].repo, "zOWNER/propagation-icaptcha");
  check("events: ref", r.body.events[0].ref, "refs/heads/main");
  check("events: sha shortened", r.body.events[0].sha, "df4830cc246b");
  check("events: pusher", r.body.events[0].pusher, "did:key:zPUSHER");
  check("events: old_sha dropped", "old_sha" in r.body.events[0], false);
  check("events: node_did dropped", "node_did" in r.body.events[0], false);
  check("events: field count", Object.keys(r.body.events[0]).length, 5);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
