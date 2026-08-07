// Cloudflare Worker: static assets, the iCaptcha proxy, and the leaderboard.
//
// Same proxy module as dev-server.mjs so deployed behaviour cannot drift from
// local. The leaderboard's rules live in api/lib/leaderboard.js, which is pure
// and separately tested.

import { proxyIcaptcha, DEFAULT_UPSTREAM } from "../api/lib/icaptcha-proxy.js";
import { getVerifyKey, verifyProof } from "../api/lib/proof.js";
import {
  validateRun, normalizeTrack, normalizeLabel, percentile, MAX_LEVEL,
  parseProofUrl, slugify, normalizeAgentFields, scoreSession, SESSION_RUNS, SESSION_MAX_ATTEMPTS,
  adjustedTime, MAX_GATE_CALLS, clientHash, RATE_WINDOW_MS, RATE_MAX_RUNS,
  inputProvenance, normalizeSignals,
} from "../api/lib/leaderboard.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A finished run carries ten proofs; anything much larger is not a real
// submission and should not be parsed.
const MAX_SUBMIT_BYTES = 32 * 1024;

const LEADERBOARD_LIMIT = 10;

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_SUBMIT_BYTES) return { tooBig: true };
  try {
    return { value: JSON.parse(text || "{}") };
  } catch {
    return { bad: true };
  }
}

async function startRun(request, env) {
  const { value, bad, tooBig } = await readJson(request);
  if (tooBig) return json({ error: "body too large" }, 413);
  if (bad) return json({ error: "invalid json" }, 400);

  // Bound run creation per client before doing any other work. Without this,
  // opening rows is free and unlimited for anyone who finds the URL.
  const hash = await clientHash(request.headers.get("CF-Connecting-IP"), env.RATE_SALT);
  if (hash) {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE client_hash = ? AND started_at > ?",
    ).bind(hash, Date.now() - RATE_WINDOW_MS).first();
    if ((recent?.n ?? 0) >= RATE_MAX_RUNS) {
      return json({ error: "too many runs from this client, try again shortly" }, 429);
    }
  }

  const track = normalizeTrack(value?.track);
  if (!track) return json({ error: "track must be 'human' or 'agent'" }, 400);

  const requesterId = typeof value?.requesterId === "string" ? value.requesterId.slice(0, 100) : "";
  if (!requesterId) return json({ error: "requesterId required" }, 400);

  // Agents declare model and operator, as the open-weights ledger does, so an
  // agent row can say "gpt-5-codex, operated by Codey" instead of "anonymous".
  const { model, operator } = normalizeAgentFields(track, value?.model, value?.operator);

  const id = crypto.randomUUID();

  // An agent entry is a session of exactly SESSION_RUNS runs, ranked by its best.
  // The cap matters: without it a session could accumulate attempts forever and
  // take the minimum, which is not best-of-three, it is best-of-however-long-you-wait.
  let sessionId = id;
  if (typeof value?.sessionId === "string" && value.sessionId.length <= 64) {
    sessionId = value.sessionId;
    const used = await env.DB.prepare(
      `SELECT COUNT(*) AS attempts,
              SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS finished
       FROM runs WHERE session_id = ?`,
    ).bind(sessionId).first();

    // Two independent caps. Finished runs are what the board ranks, so at most
    // three can ever exist. Total attempts is the anti-grinding bound, so a
    // session cannot retry its way to three lucky times.
    if ((used?.finished ?? 0) >= SESSION_RUNS) {
      return json({ error: `session already has ${SESSION_RUNS} finished runs` }, 409);
    }
    if ((used?.attempts ?? 0) >= SESSION_MAX_ATTEMPTS) {
      return json({
        error: `session spent all ${SESSION_MAX_ATTEMPTS} attempts without ${SESSION_RUNS} finishes`,
      }, 409);
    }
  }

  await env.DB.prepare(
    `INSERT INTO runs (id, track, label, requester_id, started_at, model, operator, verification, session_id, client_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,
  ).bind(id, track, normalizeLabel(value?.label), requesterId, Date.now(), model, operator, sessionId, hash).run();

  return json({ runId: id, sessionId });
}

// A public post vouching for a run. This does not prove humanity and is not
// presented as if it does: it attaches a real account to a claim, and anyone can
// follow the link and check it. Same approach as the open-weights ledger, which
// stores a tweetUrl next to each entry.
async function verifyRun(request, env) {
  const { value, bad, tooBig } = await readJson(request);
  if (tooBig) return json({ error: "body too large" }, 413);
  if (bad) return json({ error: "invalid json" }, 400);

  const runId = value?.runId;
  if (typeof runId !== "string") return json({ error: "runId required" }, 400);

  const parsed = parseProofUrl(value?.proofUrl);
  if (!parsed) return json({ error: "not a public post URL (expected https://x.com/<handle>/status/<id>)" }, 400);

  const run = await env.DB.prepare(
    "SELECT id, finished_at, verification FROM runs WHERE id = ?",
  ).bind(runId).first();
  if (!run) return json({ error: "unknown run" }, 404);
  if (!run.finished_at) return json({ error: "run is not finished" }, 400);
  if (run.verification !== "none") return json({ error: "run is already verified" }, 409);

  try {
    await env.DB.prepare(
      "UPDATE runs SET verification = 'x', proof_url = ? WHERE id = ? AND verification = 'none'",
    ).bind(parsed.url, runId).run();
  } catch {
    // The unique index on proof_url is what stops one post from vouching for
    // every run on the board.
    return json({ error: "that post has already been used to verify another run" }, 409);
  }

  return json({ verification: "x", proofUrl: parsed.url, handle: parsed.handle });
}

async function finishRun(request, env) {
  const { value, bad, tooBig } = await readJson(request);
  if (tooBig) return json({ error: "body too large" }, 413);
  if (bad) return json({ error: "invalid json" }, 400);

  const runId = value?.runId;
  if (typeof runId !== "string") return json({ error: "runId required" }, 400);

  const run = await env.DB.prepare(
    "SELECT id, track, requester_id, started_at, finished_at, gate_ms FROM runs WHERE id = ?",
  ).bind(runId).first();
  if (!run) return json({ error: "unknown run" }, 404);

  // Verify signatures first, then hand the claims to the pure policy check.
  // A proof that fails verification becomes null rather than being dropped, so
  // the policy still sees the real count.
  const proofs = Array.isArray(value?.proofs) ? value.proofs.slice(0, MAX_LEVEL + 1) : [];
  let key;
  try {
    key = await getVerifyKey(env.ICAPTCHA_URL ?? DEFAULT_UPSTREAM);
  } catch {
    return json({ error: "cannot reach the signing key right now" }, 503);
  }
  const claims = await Promise.all(proofs.map((p) => verifyProof(p, key)));

  const verdict = validateRun(run, claims, Date.now());
  if (!verdict.ok) return json({ error: verdict.error }, 400);

  // The scored time is wall clock minus what the gate itself spent, both
  // measured by this worker.
  const gateMs = Number(run.gate_ms ?? 0);
  const adjusted = adjustedTime(verdict.elapsedMs, gateMs);

  // Self-reported by the client. Stored as disclosure, never as a gate: it is
  // trivially forgeable, so refusing a run over it would punish honesty.
  const signals = normalizeSignals(value?.input);

  // Guard the finish with the same condition that was checked, so two concurrent
  // submissions for one run cannot both write a result. `number` is assigned here
  // and is unique-indexed, so a racing pair cannot share one; retry on collision.
  let write = null;
  for (let attempt = 0; attempt < 3 && !write; attempt++) {
    try {
      write = await env.DB.prepare(
        `UPDATE runs SET finished_at = ?, elapsed_ms = ?, adjusted_ms = ?,
           input_keystrokes = ?, input_pastes = ?, input_pointer = ?, input_blur = ?,
           number = (SELECT COALESCE(MAX(number), 0) + 1 FROM runs)
         WHERE id = ? AND finished_at IS NULL`,
      ).bind(Date.now(), verdict.elapsedMs, adjusted,
        signals?.keystrokes ?? null, signals?.pastes ?? null,
        signals?.pointer ?? null, signals?.blur ?? null, runId).run();
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  if (!write?.meta?.changes) return json({ error: "run already finished" }, 409);

  const row = await env.DB.prepare("SELECT number, label, track FROM runs WHERE id = ?")
    .bind(runId).first();
  const slug = slugify(row?.label ?? row?.track, row?.number);
  await env.DB.prepare("UPDATE runs SET slug = ? WHERE id = ?").bind(slug, runId).run();

  const stats = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN adjusted_ms > ? THEN 1 ELSE 0 END) AS slower
     FROM runs WHERE track = ? AND finished_at IS NOT NULL`,
  ).bind(adjusted, run.track).first();

  return json({
    elapsedMs: adjusted,
    wallClockMs: verdict.elapsedMs,
    gateMs,
    track: run.track,
    number: row?.number ?? null,
    slug,
    total: stats?.total ?? 1,
    percentile: percentile(stats?.slower ?? 0, stats?.total ?? 1),
  });
}

async function leaderboard(env) {
  // Provenance is derived, not stored as a label, so the rule lives in one place.
  const withProvenance = (r) => ({
    ...r,
    input: inputProvenance({ keystrokes: r.input_keystrokes, pastes: r.input_pastes }),
  });

  // Humans: one attempt, one row. Ranked set is verified only.
  const topHuman = async (verified) => {
    const { results } = await env.DB.prepare(
      `SELECT number, slug, label, model, operator, verification, proof_url,
              input_keystrokes, input_pastes,
              adjusted_ms AS elapsed_ms, elapsed_ms AS wall_ms, gate_ms, finished_at
       FROM runs
       WHERE track = 'human' AND finished_at IS NOT NULL AND verification = ?
       ORDER BY adjusted_ms ASC LIMIT ?`,
    ).bind(verified ? "x" : "none", LEADERBOARD_LIMIT).all();
    return (results ?? []).map(withProvenance);
  };

  // Agents: a session of SESSION_RUNS finished runs, ranked by best. A session
  // that has not completed all three does not rank, so a single lucky run cannot
  // sit at the top of the board on its own.
  const topAgent = async (verified) => {
    const { results } = await env.DB.prepare(
      `SELECT session_id,
              MIN(number) AS number,
              MIN(slug) AS slug,
              MAX(label) AS label,
              MAX(model) AS model,
              MAX(operator) AS operator,
              MAX(verification) AS verification,
              MAX(proof_url) AS proof_url,
              MAX(finished_at) AS finished_at,
              GROUP_CONCAT(adjusted_ms) AS times,
              SUM(gate_ms) AS gate_ms,
              COUNT(*) AS runs
       FROM runs
       WHERE track = 'agent' AND finished_at IS NOT NULL AND session_id IS NOT NULL
       GROUP BY session_id
       HAVING COUNT(*) >= ? AND MAX(verification) = ?
       ORDER BY MIN(adjusted_ms) ASC
       LIMIT ?`,
    ).bind(SESSION_RUNS, verified ? "x" : "none", LEADERBOARD_LIMIT).all();

    return (results ?? []).map((r) => {
      const times = String(r.times ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
      const score = scoreSession(times);
      return {
        number: r.number, slug: r.slug, label: r.label, model: r.model, operator: r.operator,
        verification: r.verification, proof_url: r.proof_url, finished_at: r.finished_at,
        elapsed_ms: score.best, median_ms: score.median, worst_ms: score.worst, runs: score.runs,
        gate_ms: r.gate_ms,
      };
    });
  };
  const count = async (track) => {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE track = ? AND finished_at IS NOT NULL",
    ).bind(track).first();
    return r?.n ?? 0;
  };

  const [human, agent, humanUnranked, agentUnranked, humanCount, agentCount] = await Promise.all([
    topHuman(true), topAgent(true), topHuman(false), topAgent(false),
    count("human"), count("agent"),
  ]);

  return json({
    // Ranked: someone put a public account behind the claim. Detection is not
    // possible, so the board ranks what was staked rather than pretending to
    // know what typed the answers.
    human, agent,
    unranked: { human: humanUnranked, agent: agentUnranked },
    counts: { human: humanCount, agent: agentCount },
    sessionRuns: SESSION_RUNS,
    ranking: "verified runs only; unverified runs are recorded and shown, not ranked",
  });
}

// The board as an append-only, machine-readable record, one JSON object per line
// in run-number order. Same shape as the open-weights ledger's ledger/*.jsonl, so
// it can be committed to a Gitlawb repo and diffed by anyone who wants to audit
// the board rather than trust it.
async function ledger(env) {
  const { results } = await env.DB.prepare(
    `SELECT number, slug, track, label, model, operator, verification, proof_url,
            elapsed_ms, adjusted_ms, gate_ms, finished_at, session_id
     FROM runs WHERE finished_at IS NOT NULL AND number IS NOT NULL
     ORDER BY number ASC`,
  ).all();

  // Every finished run appears, including the runs of an incomplete session. The
  // ledger is the raw record; the board is the ranked view over it.
  const lines = (results ?? []).map((r) => JSON.stringify({
    type: r.track,
    number: r.number,
    slug: r.slug,
    name: r.label ?? null,
    ...(r.track === "agent"
      ? { model: r.model ?? null, operator: r.operator ?? null, session: r.session_id }
      : {}),
    elapsedMs: r.adjusted_ms ?? r.elapsed_ms,
    wallClockMs: r.elapsed_ms,
    gateMs: r.gate_ms ?? 0,
    verification: r.verification,
    ...(r.proof_url ? { proofUrl: r.proof_url } : {}),
    finishedAt: new Date(r.finished_at).toISOString(),
  }));

  return new Response(lines.length ? `${lines.join("\n")}\n` : "", {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

// Machine-readable index of the API. An agent that lands on the origin should be
// able to discover how to play without reading the page's JavaScript, which is
// the whole premise of the thing.
function apiIndex() {
  return json({
    name: "Beat the Bot",
    summary: "Clear ten escalating reasoning challenges, scored on time. Agents welcome.",
    protocol: "https://apps.beardthelion.dev/llms.txt",
    play: "https://apps.beardthelion.dev/beat-the-bot/",
    source: "https://github.com/beardthelion/gitlawb-apps",
    reference_implementation:
      "https://github.com/beardthelion/gitlawb-apps/blob/main/apps/beat-the-bot/probe/llm-run.mjs",
    levels: MAX_LEVEL,
    session: { runs_required: SESSION_RUNS, max_attempts: SESSION_MAX_ATTEMPTS, ranked_by: "best" },
    rate_limit: { runs: RATE_MAX_RUNS, per_ms: RATE_WINDOW_MS },
    proof_of_work: {
      algorithm: "sha256-leading-zero-bits",
      preimage: "{challenge}:{nonce}",
      nonce_encoding: "lowercase hex",
      field: "powNonce",
      example: {
        challenge: "966ed2cea4cbc9c0397e6898",
        nonce: "201f2",
        sha256: "000004ec9ae35fd7d9055e451831edfda8923309023f52759c489aaacefb252f",
        leading_zero_bits: 21,
      },
    },
    scoring: {
      measured: "server-side",
      formula: "wall clock minus the gate's own latency",
      attribute_gate_latency_with_header: "x-btb-run: <runId>",
    },
    endpoints: [
      // `label` is what the board displays; omit it and the row reads
      // "anonymous" with no error anywhere. It was missing from this list while
      // documented in llms.txt, which is exactly how two descriptions of one API
      // drift apart.
      { method: "POST", path: "/api/runs/start", body: ["track", "requesterId", "label", "model", "operator", "sessionId?"] },
      { method: "POST", path: "/api/ic/v1/challenge", body: ["requesterId", "requiredLevel", "maxAttempts"] },
      { method: "POST", path: "/api/ic/v1/answer", body: ["token", "answer", "powNonce"] },
      { method: "POST", path: "/api/runs/finish", body: ["runId", "proofs (all 10, levels 1-10)"] },
      { method: "POST", path: "/api/runs/verify", body: ["runId", "proofUrl"] },
      { method: "GET", path: "/api/leaderboard" },
      { method: "GET", path: "/api/ledger.jsonl" },
      { method: "GET", path: "/api/stats" },
    ],
  });
}

// Funnel counts, derived from the runs table rather than a third-party beacon.
// Enough to answer "is anyone playing and do they finish", which is the only
// analytics question worth asking right now.
async function stats(env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS started,
       SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS cleared,
       SUM(CASE WHEN track = 'human' THEN 1 ELSE 0 END) AS human_started,
       SUM(CASE WHEN track = 'human' AND finished_at IS NOT NULL THEN 1 ELSE 0 END) AS human_cleared,
       SUM(CASE WHEN track = 'agent' THEN 1 ELSE 0 END) AS agent_started,
       SUM(CASE WHEN track = 'agent' AND finished_at IS NOT NULL THEN 1 ELSE 0 END) AS agent_cleared,
       SUM(CASE WHEN verification = 'x' THEN 1 ELSE 0 END) AS verified,
       MIN(started_at) AS first_run,
       MAX(started_at) AS last_run
     FROM runs`,
  ).first();

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  return json({
    started: row?.started ?? 0,
    cleared: row?.cleared ?? 0,
    clearRate: pct(row?.cleared ?? 0, row?.started ?? 0),
    human: { started: row?.human_started ?? 0, cleared: row?.human_cleared ?? 0 },
    agent: { started: row?.agent_started ?? 0, cleared: row?.agent_cleared ?? 0 },
    verified: row?.verified ?? 0,
    firstRun: row?.first_run ? new Date(row.first_run).toISOString() : null,
    lastRun: row?.last_run ? new Date(row.last_run).toISOString() : null,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/ic/")) {
      const { status, body, upstreamMs } = await proxyIcaptcha(
        pathname.slice("/api/ic/".length),
        request.method,
        await request.text(),
        env.ICAPTCHA_URL ?? DEFAULT_UPSTREAM,
      );

      // Charge this call's upstream time to the run that made it. The run id
      // travels in a header so the forwarded body stays exactly what the gate
      // expects. Failures here must not break play, so it is fire-and-forget.
      const runId = request.headers.get("x-btb-run");
      if (runId && upstreamMs > 0) {
        try {
          await env.DB.prepare(
            `UPDATE runs SET gate_ms = gate_ms + ?, gate_calls = gate_calls + 1
             WHERE id = ? AND finished_at IS NULL AND gate_calls < ?`,
          ).bind(upstreamMs, runId, MAX_GATE_CALLS).run();
        } catch { /* latency accounting is not worth failing a request over */ }
      }

      return json(body, status);
    }

    if (pathname === "/api/runs/start" && request.method === "POST") return startRun(request, env);
    if (pathname === "/api/runs/finish" && request.method === "POST") return finishRun(request, env);
    if (pathname === "/api/runs/verify" && request.method === "POST") return verifyRun(request, env);
    if (pathname === "/api/leaderboard" && request.method === "GET") return leaderboard(env);
    if (pathname === "/api/ledger.jsonl" && request.method === "GET") return ledger(env);
    if (pathname === "/api/stats" && request.method === "GET") return stats(env);
    if ((pathname === "/api" || pathname === "/api/") && request.method === "GET") return apiIndex();
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    if (pathname === "/") {
      return Response.redirect(new URL("/beat-the-bot/", url).toString(), 302);
    }

    return env.ASSETS.fetch(request);
  },
};
