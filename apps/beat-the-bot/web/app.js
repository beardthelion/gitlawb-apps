// Beat the Bot: play the iCaptcha ladder against the clock.
//
// Run rules: ten levels, each requested with maxAttempts 1 so a miss ends the
// run. The score is time to clear, not level reached, because P0 established
// that almost everyone clears all ten (see plans/beat-the-bot.md).

import { PowPool } from "./pow-pool.js";

const MAX_LEVEL = 10;
const API = "/api/ic";

const pool = new PowPool();

const state = {
  requesterId: null,
  runId: null,
  proofs: [],
  standing: null, // {percentile, total} once the board has scored the run
  level: 1,
  challenge: null,
  powPromise: null,
  powResult: null,
  powMsTotal: 0,
  startedAt: 0,
  levelStartedAt: 0,
  splits: [],
  phase: "idle", // idle | playing | grading | over
};

const $ = (id) => document.getElementById(id);

// Self-reported input provenance. Sent with the run and shown on the board as a
// property of the claim, never as a gate: an agent driving a real browser
// produces real keystrokes, so this cannot prove anything. It distinguishes
// someone typing from someone pasting, and that is all it claims to do.
const signals = { keystrokes: 0, pastes: 0, pointer: 0, blur: 0 };
const resetSignals = () => Object.keys(signals).forEach((k) => { signals[k] = 0; });
addEventListener("keydown", (e) => { if (!e.metaKey && !e.ctrlKey) signals.keystrokes++; }, true);
addEventListener("paste", () => { signals.pastes++; }, true);
addEventListener("pointermove", () => { signals.pointer++; }, { passive: true, capture: true });
addEventListener("blur", () => { signals.blur++; });

// The board is the human-vs-human framing: a player's result is reported against
// other people first, with the machine times as a separate track rather than as
// the bar they failed to clear.
async function api(path, body) {
  try {
    const res = await fetch(path, body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      : { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const el = {
  timer: $("timer"),
  pips: $("pips"),
  type: $("challenge-type"),
  prompt: $("prompt"),
  input: $("answer"),
  submit: $("submit"),
  pow: $("pow-status"),
  intro: $("intro"),
  game: $("game"),
  result: $("result"),
  startBtn: $("start"),
  form: $("answer-form"),
  label: $("label"),
  board: $("board-body"),
};

const fmt = (ms) => {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(2)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(2)}s`;
};

// fetch has no default timeout, so a slow gate would leave the page sitting on
// "requesting challenge..." forever with the clock running. Seen once in testing.
const REQUEST_TIMEOUT_MS = 15_000;

async function post(path, body) {
  let res;
  try {
    res = await fetch(`${API}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Lets the worker charge this call's upstream latency to the run, so the
        // score is thinking time rather than however slow the gate was today.
        ...(state.runId ? { "x-btb-run": state.runId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { status: 0, json: { error: "network" } };
  }
  let json;
  try {
    json = await res.json();
  } catch {
    json = { error: "bad response" };
  }
  return { status: res.status, json };
}

// --- timer ---------------------------------------------------------------

let rafId = null;
function tick() {
  el.timer.textContent = fmt(performance.now() - state.startedAt);
  rafId = requestAnimationFrame(tick);
}
function stopTimer() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

// --- rendering -----------------------------------------------------------

function renderPips() {
  el.pips.innerHTML = "";
  for (let i = 1; i <= MAX_LEVEL; i++) {
    const pip = document.createElement("span");
    pip.className = "pip" + (i < state.level ? " done" : i === state.level ? " current" : "");
    pip.title = `level ${i}`;
    el.pips.append(pip);
  }
}

function setPow(text, cls = "") {
  el.pow.textContent = text;
  el.pow.className = `pow ${cls}`;
}

// --- proof of work -------------------------------------------------------

// Start solving the instant a challenge arrives, while the player is still
// reading. By submit time the nonce is normally already waiting.
function startSolving(challenge) {
  state.powResult = null;
  if (!challenge.pow) {
    state.powPromise = Promise.resolve(null);
    setPow("no proof of work required", "ready");
    return;
  }
  setPow("proof of work: solving...", "working");
  state.powPromise = pool
    .solve(challenge.pow, (hashes) => {
      if (!state.powResult) setPow(`proof of work: ${(hashes / 1e6).toFixed(1)}M hashes...`, "working");
    })
    .then((r) => {
      state.powResult = r;
      state.powMsTotal += r.ms;
      setPow(`proof of work ready (${r.searched.toLocaleString()} hashes, ${r.ms}ms)`, "ready");
      return r;
    })
    .catch(() => {
      setPow("proof of work failed", "error");
      return null;
    });
}

// --- game flow -----------------------------------------------------------

async function nextChallenge() {
  el.input.disabled = true;
  el.submit.disabled = true;
  el.prompt.textContent = "requesting challenge...";
  el.type.textContent = "";

  const request = () => post("v1/challenge", {
    requesterId: state.requesterId,
    requiredLevel: state.level,
    maxAttempts: 1,
  });

  let { status, json } = await request();
  // The gate answers 429 under burst. Losing a run mid-ladder to a transient
  // rate limit would be our failure, not the player's, so retry once first.
  if (status === 429) {
    setPow("the gate is busy, retrying...", "working");
    await new Promise((r) => setTimeout(r, 1500));
    ({ status, json } = await request());
  }

  if (status !== 200 || !json.token) {
    abort(status === 0
      ? "The gate didn't answer in time. Your run wasn't counted."
      : `The gate refused the challenge request (${status}). Your run wasn't counted.`);
    return;
  }

  state.challenge = json;
  state.phase = "playing";
  renderPips();
  el.type.textContent = `${json.type} · difficulty ${json.difficulty}`;
  el.prompt.textContent = json.prompt;
  el.input.disabled = false;
  el.submit.disabled = false;
  el.input.value = "";
  el.input.focus();

  // The clock starts when the first prompt is actually on screen, so the initial
  // challenge request is not charged to the player.
  if (state.level === 1) {
    state.startedAt = performance.now();
    state.levelStartedAt = state.startedAt;
    stopTimer();
    tick();
  }

  startSolving(json);
}

async function submitAnswer(answer) {
  if (state.phase !== "playing") return;
  state.phase = "grading";
  el.input.disabled = true;
  el.submit.disabled = true;

  if (state.powPromise) {
    if (!state.powResult) setPow("proof of work: finishing...", "working");
    await state.powPromise;
  }

  const send = () =>
    post("v1/answer", {
      token: state.challenge.token,
      answer,
      powNonce: state.powResult?.nonce,
    });

  let { status, json } = await send();

  // A rejected proof of work does not consume the attempt (verified in P0), so
  // solving again and resubmitting is safe and costs the player nothing but time.
  if (isPowRejection(json)) {
    setPow("proof of work rejected, retrying...", "working");
    startSolving(state.challenge);
    await state.powPromise;
    ({ status, json } = await send());
  }

  // If the proof of work still will not go through, that is our failure, not the
  // player's. Scoring it as a loss would blame them for a broken tab, which is
  // exactly what happened the first time this ran end to end.
  if (isPowRejection(json)) {
    abort("The proof of work could not be minted in this browser. That's on us, not you.");
    return;
  }

  if (status !== 200) {
    abort(`The gate stopped responding (${status}). Your run wasn't counted.`);
    return;
  }

  if (json.status === "passed") {
    // Measured from the end of the previous level, not from when this prompt
    // rendered, so the grading round trip and the next challenge fetch belong to
    // some level instead of vanishing. The splits then sum to the total shown.
    const now = performance.now();
    state.splits.push({ level: state.level, ms: now - state.levelStartedAt, type: state.challenge.type });
    state.levelStartedAt = now;
    // Each level mints its own signed proof. All ten are submitted together,
    // because one level-10 proof on its own proves nothing: the gate will issue a
    // level-10 challenge directly to anyone who asks for it.
    if (json.proof) state.proofs.push(json.proof);

    if (state.level >= MAX_LEVEL) {
      state.level = MAX_LEVEL + 1;
      renderPips();
      // Stop the player's clock here, before the board round trip. Submitting is
      // our latency, not their time, and counting it made the displayed total
      // exceed the sum of the splits.
      state.completedAt = now;
      await submitRun();
      finish(true);
      return;
    }
    state.level += 1;
    await nextChallenge();
    return;
  }

  // "continue" means the service allotted another attempt despite maxAttempts 1.
  // Either way the player got it wrong, and the run is over.
  finish(false, json.reason);
}

const isPowRejection = (json) =>
  json?.status === "failed" && String(json.reason ?? "").includes("proof-of-work");

// A run that ended because something on our side broke. Distinct from losing:
// no score, no splits, no "you got it wrong".
function abort(message) {
  state.phase = "over";
  stopTimer();
  pool.cancel();
  el.game.hidden = true;
  el.result.hidden = false;
  el.result.replaceChildren();

  const h = document.createElement("h2");
  h.className = "lost";
  h.textContent = "RUN ABANDONED";
  const p = document.createElement("p");
  p.className = "sub";
  p.textContent = message;
  const again = document.createElement("button");
  again.className = "primary";
  again.textContent = "try again";
  again.addEventListener("click", startRun);
  el.result.append(h, p, again);
}

function finish(cleared, reason) {
  state.phase = "over";
  stopTimer();
  pool.cancel();
  const total = (state.completedAt ?? performance.now()) - state.startedAt;

  el.game.hidden = true;
  el.result.hidden = false;

  const levelsCleared = state.splits.length;

  // Everything here is built as DOM nodes rather than an HTML string, because
  // `reason` and `type` come from the upstream service and board labels come
  // from other players. Neither should get a say in this page's markup.
  el.result.replaceChildren();
  el.result.append(
    node("h2", cleared ? "won" : "lost", cleared ? "GATE CLEARED" : "STOPPED AT THE GATE"),
    node("p", "headline", cleared
      ? fmt(state.standing?.scoredMs ?? total)
      : `${levelsCleared}/${MAX_LEVEL} levels`),
    node("p", "sub", cleared
      ? (state.standing?.gateMs
        ? `${fmt(state.standing.wallClockMs)} on the clock, minus ${fmt(state.standing.gateMs)} `
          + `the gate spent thinking about it. You are scored on the rest.`
        : `${fmt(state.powMsTotal)} of that was proof of work your machine had to burn.`)
      : `Level ${levelsCleared + 1} got you${reason ? ` (${reason})` : ""}.`),
  );

  // Ranked against other people, not against the machine. A player who is slower
  // than every bot can still be faster than most humans, and that is the number
  // worth showing them.
  if (cleared && state.standing) {
    const { percentile: p, total } = state.standing;
    el.result.append(node("p", "standing",
      total <= 1
        ? "First human through the gate. Everyone else is measured against you now."
        : `Faster than ${p}% of the ${total} humans who have cleared it.`));
  }

  // The score reconciliation uses only server-measured numbers, so the three
  // lines are exactly consistent. The per-level splits below are measured in this
  // browser and will not sum to it: they start when a prompt is painted, while
  // the server's clock starts when the run is opened. Showing them as if they
  // added up to the score would be a lie that any careful player could catch.
  if (cleared && state.standing?.gateMs) {
    const recon = node("table", "splits recon");
    const rbody = node("tbody");
    const line = (cls, name, value) => {
      const tr = node("tr", cls);
      tr.append(node("td", null, ""), node("td", null, name), node("td", null, value));
      return tr;
    };
    rbody.append(
      line(null, "on the clock", fmt(state.standing.wallClockMs)),
      line("split-adjust", "the gate's own latency", `− ${fmt(state.standing.gateMs)}`),
      line("split-total", "your time", fmt(state.standing.scoredMs)),
    );
    recon.append(rbody);
    el.result.append(recon);
  }

  if (state.splits.length) {
    const cap = node("p", "splits-caption", "per level, measured in this browser");
    el.result.append(cap);
    const table = node("table", "splits");
    const head = node("tr");
    for (const h of ["level", "type", "split"]) head.append(node("th", null, h));
    const thead = node("thead");
    thead.append(head);
    table.append(thead);
    const body = node("tbody");
    for (const s of state.splits) {
      const tr = node("tr");
      tr.append(node("td", null, String(s.level)), node("td", null, s.type), node("td", null, fmt(s.ms)));
      body.append(tr);
    }

    table.append(body);
    el.result.append(table);
  }

  // Verification is also distribution: the post that vouches for a run is a post
  // about the run. One action, both jobs.
  if (cleared && state.runId && state.standing) {
    el.result.append(buildVerifyBlock(total));
  } else if (!cleared && levelsCleared > 0) {
    // Most players will not clear ten levels, so giving only winners something to
    // post throws away most of the traffic. Losing to a reasoning puzzle is a
    // perfectly good thing to post about.
    el.result.append(buildBragBlock(levelsCleared, state.splits.at(-1)?.type));
  }

  const again = node("button", "primary", "play again");
  again.addEventListener("click", startRun);
  el.result.append(again);
}

// Score the finished run. The board is optional: if it is unreachable the run
// still shows its own time, it just doesn't get ranked.
async function submitRun() {
  if (!state.runId) return;
  const res = await api("/api/runs/finish", {
    runId: state.runId, proofs: state.proofs, input: { ...signals },
  });
  if (res && typeof res.percentile === "number") {
    state.standing = {
      percentile: res.percentile, total: res.total, number: res.number, slug: res.slug,
      scoredMs: res.elapsedMs, wallClockMs: res.wallClockMs, gateMs: res.gateMs,
    };
  }
  loadBoard();
}

async function startRun() {
  const requesterId = `web-${Math.random().toString(36).slice(2, 10)}`;
  Object.assign(state, {
    requesterId,
    runId: null,
    proofs: [],
    standing: null,
    completedAt: null, // must reset, or a second run shows the first run's total
    level: 1,
    challenge: null,
    powPromise: null,
    powResult: null,
    powMsTotal: 0,
    startedAt: performance.now(),
    splits: [],
    phase: "playing",
  });
  resetSignals();
  el.intro.hidden = true;
  el.result.hidden = true;
  el.game.hidden = false;
  el.timer.textContent = "0.00s";
  renderPips();

  // Open the run server-side before the first challenge, so the official time is
  // measured by the worker and cannot be improved by editing this file.
  const started = await api("/api/runs/start", {
    track: "human",
    requesterId,
    label: el.label?.value ?? null,
  });
  state.runId = started?.runId ?? null;

  await nextChallenge();
}

// --- verification --------------------------------------------------------

// The consolation share. No verification here: there is no proof to vouch for,
// and asking someone who just lost to paste a link is asking too much.
function buildBragBlock(levelsCleared, lastType) {
  const wrap = node("div", "verify");
  wrap.append(node("div", "verify-title", "Make someone else try it"));
  wrap.append(node("p", "verify-copy",
    `You got ${levelsCleared} of ${MAX_LEVEL}. An AI agent clears all ten. `
    + `Find out whether anyone you know does better.`));

  const stopper = lastType ? ` A ${lastType} problem got me.` : "";
  const text = `I got ${levelsCleared}/${MAX_LEVEL} on the @gitlawb iCaptcha gate.${stopper} `
    + `It's a CAPTCHA that keeps humans out and lets AI through. `
    + `${location.origin}/beat-the-bot/`;

  const post = document.createElement("a");
  post.className = "primary as-button";
  post.href = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
  post.target = "_blank";
  post.rel = "noopener noreferrer";
  post.textContent = "post it";
  wrap.append(post);
  return wrap;
}

function buildVerifyBlock(totalMs) {
  const wrap = node("div", "verify");
  wrap.append(node("div", "verify-title", "Put your name on it"));
  wrap.append(node("p", "verify-copy",
    "An unverified time is just a number in a database. Post it, paste the link, "
    + "and the board shows your run as vouched for by a real account."));

  // The scored time, not the wall clock. The board, the headline and the post
  // have to agree, or the most public surface contradicts the page it links to.
  const scored = state.standing?.scoredMs ?? totalMs;
  const text = `I cleared the @gitlawb iCaptcha gate in ${fmt(scored)}. `
    + `A CAPTCHA that keeps humans out and lets AI through. `
    + `Run #${state.standing?.number ?? ""} ${location.origin}/beat-the-bot/`;

  const post = document.createElement("a");
  post.className = "primary as-button";
  post.href = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
  post.target = "_blank";
  post.rel = "noopener noreferrer";
  post.textContent = "post it";

  const row = node("div", "verify-row");
  const input = document.createElement("input");
  input.type = "url";
  input.placeholder = "paste the post link";
  input.autocomplete = "off";
  const submit = node("button", "ghost", "verify");
  const status = node("div", "verify-status");

  submit.addEventListener("click", async () => {
    const proofUrl = input.value.trim();
    if (!proofUrl) return;
    submit.disabled = true;
    status.textContent = "checking...";
    const res = await api("/api/runs/verify", { runId: state.runId, proofUrl });
    if (res?.verification === "x") {
      status.className = "verify-status ok";
      status.textContent = `verified as @${res.handle}`;
      input.disabled = true;
      loadBoard();
    } else {
      submit.disabled = false;
      status.className = "verify-status bad";
      status.textContent = "that link wasn't accepted. It should look like https://x.com/you/status/123.";
    }
  });

  row.append(input, submit);
  wrap.append(post, row, status);
  return wrap;
}

// --- the board -----------------------------------------------------------

let boardData = null;
let boardView = "human";

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// A row shows what it claims to be and, separately, how that claim was proved.
// Nothing here detects a human. An unverified entry is visibly weaker than a
// verified one rather than being excluded.
function verificationBadge(row) {
  if (row.verification === "x" && row.proof_url) {
    const a = document.createElement("a");
    a.className = "badge badge-x";
    a.href = row.proof_url;          // already normalized server-side to https://x.com/...
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    a.textContent = "verified";
    a.title = "Vouched for by a public post. Follow the link and check it yourself.";
    return a;
  }
  const s = node("span", "badge badge-none", "unverified");
  s.title = "Nobody has staked a public account on this run.";
  return s;
}

function rankList(rows, emptyText) {
  if (!rows?.length) return node("p", "board-empty", emptyText);
  const table = node("table", "splits");
  const body = node("tbody");
  rows.forEach((r, i) => {
    const tr = node("tr");

    const who = node("td");
    who.append(node("span", "who-name", r.label || "anonymous"));
    // Agents declare model and operator, so the row is worth reading.
    if (r.model || r.operator) {
      const parts = [r.model, r.operator ? `operated by ${r.operator}` : null].filter(Boolean);
      who.append(node("div", "who-meta", parts.join(" · ")));
    }
    // Ranked on the best of the session, but the median says whether the entrant
    // is reliably that fast or got one good run.
    if (r.runs > 1 && typeof r.median_ms === "number") {
      who.append(node("div", "who-meta", `best of ${r.runs} · median ${fmt(r.median_ms)}`));
    }

    const badge = node("td", "badge-cell");
    if (r.input && r.input !== "unknown") {
      const chip = node("span", `badge badge-input badge-${r.input}`, r.input);
      chip.title = "Self-reported by the client. Forgeable, so it is shown as a "
        + "property of the claim, not as proof.";
      badge.append(chip, document.createTextNode(" "));
    }
    badge.append(verificationBadge(r));

    tr.append(node("td", "rank", `${i + 1}`), who, badge, node("td", null, fmt(r.elapsed_ms)));
    body.append(tr);
  });
  table.append(body);
  return table;
}

function renderBoard() {
  el.board.replaceChildren();
  if (!boardData) {
    el.board.append(node("p", "board-empty", "board unavailable"));
    return;
  }

  const unrankedFor = (track) => boardData.unranked?.[track] ?? [];

  const appendUnranked = (track) => {
    const rows = unrankedFor(track);
    if (!rows.length) return;
    el.board.append(node("p", "splits-caption", "recorded, not ranked"));
    el.board.append(rankList(rows, ""));
    el.board.append(node("p", "board-note",
      "A time only ranks once someone puts a public account behind it. Nothing here "
      + "can tell a human from an agent, so the board ranks what was staked rather "
      + "than what was claimed."));
  };

  if (boardView === "human") {
    el.board.append(rankList(boardData.human,
      "No verified human runs yet. Clear it, post your time, and you're on the board."));
    appendUnranked("human");
    return;
  }
  if (boardView === "agent") {
    el.board.append(rankList(boardData.agent,
      `No verified agent sessions yet. An entry is the best of ${boardData.sessionRuns ?? 3} runs.`));
    appendUnranked("agent");
    return;
  }

  // Head to head: the fastest of each track, side by side.
  const bestHuman = boardData.human?.[0];
  const bestAgent = boardData.agent?.[0];
  if (!bestHuman || !bestAgent) {
    el.board.append(node("p", "board-empty",
      "Need at least one run on each track before there's a race."));
    return;
  }

  const wrap = node("div", "versus");
  const side = (title, row, cls) => {
    const d = node("div", `vs-side ${cls}`);
    d.append(
      node("div", "vs-title", title),
      node("div", "vs-time", fmt(row.elapsed_ms)),
      node("div", "vs-who", row.label || "anonymous"),
    );
    return d;
  };
  wrap.append(side("BEST HUMAN", bestHuman, "vs-human"), side("BEST AGENT", bestAgent, "vs-agent"));
  el.board.append(wrap);

  const gap = bestHuman.elapsed_ms / bestAgent.elapsed_ms;
  el.board.append(node("p", "vs-gap",
    gap >= 1
      ? `The machine is ${gap.toFixed(1)}x faster through the gate.`
      : `A human is ${(1 / gap).toFixed(1)}x faster than the best machine run. That shouldn't happen.`));
}

async function loadBoard() {
  boardData = await api("/api/leaderboard");
  renderBoard();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    boardView = tab.dataset.view;
    renderBoard();
  });
}

loadBoard();

el.startBtn.addEventListener("click", startRun);
el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const answer = el.input.value.trim();
  if (answer) submitAnswer(answer);
});
