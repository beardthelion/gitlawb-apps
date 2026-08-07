// The canvas half of the time-lapse, and the live layer that takes over when it
// ends. Everything either half draws comes out of lib/timelapse.js and
// lib/live.js; this file owns pixels, the frame loop, the poll timer and the
// controls, and no arithmetic about the network.
//
// One canvas, one coordinate space. The replay runs five months and stops on
// today, and live mode keeps drawing into the same field, so a repository that
// gets pushed while you are watching lands where the replay left off rather than
// in a second widget with its own axes.
//
// Security posture matches the rest of the page: nothing from the snapshot or
// from the live node reaches the document through innerHTML. Repository names
// arrive from a public network anyone can write to, and they are either drawn
// with fillText onto a canvas, where they are glyphs rather than markup, or set
// as textContent on an element created here. The only style properties written
// are numeric widths.

import { formatCount, dayLabel, truncateDid } from "./lib/derive.js";
import { createTimelapse, DEFAULT_DURATION_MS, splitmix32 } from "./lib/timelapse.js";
import {
  POLL_MS, repoKey, validatePayload, diffStats, diffRepos, shouldFetchRepos,
  formatAge, nextBackoffMs,
} from "./lib/live.js";

const TAU = Math.PI * 2;
const FLASH_MS = 700;
// A busy frame on the 978-repo day can bring in a hundred arrivals at once.
// Every one of them gets its dot, but only the most recent get a flash ring, so
// the per-frame cost stays flat instead of tracking the burst.
const MAX_FLASHES = 90;

// The proxy's own upstream timeout is 8s and it caches for 30s, so a request
// that has not answered in 10 is not slow, it is gone.
const FETCH_TIMEOUT_MS = 10_000;
const REPOS_LIMIT = 30;
const FEED_MAX = 8;
// Past this, the readout stops saying only "live" and starts saying out loud
// that nothing has happened. Two repositories move in a quarter of an hour on
// this network, so three minutes of silence is ordinary and still looks broken.
const QUIET_MS = 3 * 60_000;

const $ = (id) => document.getElementById(id);

const cssColor = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// FNV-1a over the repo key. Only used to seed a position for a repository the
// snapshot has never seen, so that the same repository lands in the same place
// on every machine and on every reload rather than jumping around the field.
const hashKey = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export function renderTimelapse(snapshot) {
  const canvas = $("tl-canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return; // no 2d context: the text alternative below still stands

  const tl = createTimelapse(snapshot, { durationMs: DEFAULT_DURATION_MS });
  const dayBase = snapshot.day_base;
  // Repos are the accent cyan on the canvas, matching the repo series on the
  // growth curve below. The agent counter is the second accent, set in CSS on
  // the readout, so the two series mean the same thing in both places.
  const dotColor = cssColor("--accent", "#34e2ea");
  const dimColor = cssColor("--dim", "#6b7b80");
  // A repository that already exists and got pushed again is not a new object,
  // so it pulses in the second accent instead of adding a dot in the first.
  const pulseColor = cssColor("--accent2", "#ffa657");

  // --- the text alternative ---------------------------------------------
  // A canvas is a hole in the page for anything that does not look at it, so the
  // same outcome is stated in prose and as the canvas label.
  const summary =
    `A replay of ${formatCount(tl.dayCount)} days, ${dayLabel(dayBase, 0)} to ` +
    `${dayLabel(dayBase, tl.dayCount - 1)}. One dot per repository, placed near the ` +
    `other repositories of its owner, appearing on the day it was created. It ends at ` +
    `${formatCount(tl.totalRepos)} repositories across ` +
    `${formatCount(Array.isArray(snapshot.owners) ? snapshot.owners.length : 0)} owners, ` +
    `alongside ${formatCount(tl.totalAgents)} registered agents. It then hands off to live ` +
    `mode, which keeps the same field and marks repositories as the node reports them moving.`;
  $("tl-alt").textContent = summary;
  canvas.setAttribute("aria-label", summary);

  // --- pixels -------------------------------------------------------------
  // The accumulated dots live on their own canvas and are drawn once each. The
  // visible canvas is a blit of that plus the handful of arrival rings still
  // fading, so a frame costs the same at dot 3,150 as at dot 10.
  const settled = document.createElement("canvas");
  const sctx = settled.getContext("2d");
  let pixW = 0;
  let pixH = 0;
  let dpr = 1;
  let dotRadius = 1.6;

  // How many repos, in arrival order, are already painted onto `settled`.
  let painted = 0;
  // Positions of repositories that live mode added, keyed by owner/name. Kept
  // because setting canvas.width wipes the bitmap and a resize has to be able to
  // lay the whole field down again, live arrivals included.
  const liveDots = new Map();

  const paintAt = (x, y, alpha, color) => {
    sctx.globalAlpha = alpha;
    sctx.fillStyle = color;
    sctx.beginPath();
    sctx.arc(x * pixW, y * pixH, dotRadius, 0, TAU);
    sctx.fill();
    sctx.globalAlpha = 1;
  };

  const paintDot = (i, alpha = 1) => {
    const p = tl.positionOf(i);
    paintAt(p.x, p.y, alpha, dotColor);
  };

  const repaintAll = () => {
    sctx.clearRect(0, 0, pixW, pixH);
    for (let k = 0; k < painted; k++) paintDot(tl.order[k], 0.72);
    for (const p of liveDots.values()) paintAt(p.x, p.y, 0.85, dotColor);
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Capped at 2. Beyond that the extra pixels cost more than they show for a
    // field of 1.6px dots.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (w === pixW && h === pixH) return;
    pixW = w;
    pixH = h;
    canvas.width = w;
    canvas.height = h;
    settled.width = w;
    settled.height = h;
    // Scaled to the drawn width, not to dpr alone. At 300px a 1.6dpr dot turned
    // the crowded middle of the field into one solid shape.
    dotRadius = Math.max(1, Math.min(1.7, rect.width / 470) * dpr);
    // Setting .width resets the bitmap, so everything already arrived has to be
    // laid down again. This is the one full redraw in the file and it only
    // happens on a resize.
    repaintAll();
    draw();
  };

  // --- playback -----------------------------------------------------------
  const reduced = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  let elapsed = 0;
  let progress = 0;
  let playing = false;
  let lastTs = 0;
  let raf = 0;
  const flashes = [];

  const playBtn = $("tl-play");
  const restartBtn = $("tl-restart");
  const modeBtn = $("tl-mode");
  const bar = $("tl-progress");
  const fill = $("tl-progress-fill");
  const dateOut = $("tl-date");
  const repoOut = $("tl-repos");
  const agentOut = $("tl-agents");

  let lastDay = -1;
  let lastRepos = -1;
  let lastAgents = -1;
  let lastName = "";

  const readout = (state) => {
    if (state.dayIndex !== lastDay) {
      dateOut.textContent = dayLabel(dayBase, state.dayIndex);
      lastDay = state.dayIndex;
    }
    if (state.repos !== lastRepos) {
      repoOut.textContent = `${formatCount(state.repos)} repos`;
      lastRepos = state.repos;
    }
    if (state.agents !== lastAgents) {
      agentOut.textContent = `${formatCount(state.agents)} agents`;
      lastAgents = state.agents;
    }
    const pct = (progress * 100).toFixed(2);
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", Math.round(progress * 100));
    bar.setAttribute("aria-valuetext", `${dayLabel(dayBase, state.dayIndex)}, ${formatCount(state.repos)} repositories`);
  };

  const pushFlash = (x, y, t, color) => {
    // Reduced motion gets the dot and none of the expanding ring.
    if (reduced) return;
    flashes.push({ x, y, t, color });
  };

  const draw = (now = 0) => {
    if (pixW === 0) return;
    ctx.clearRect(0, 0, pixW, pixH);
    ctx.drawImage(settled, 0, 0);

    for (let k = flashes.length - 1; k >= 0; k--) {
      const f = flashes[k];
      const age = (now - f.t) / FLASH_MS;
      if (age >= 1 || age < 0) { flashes.splice(k, 1); continue; }
      ctx.globalAlpha = (1 - age) * 0.9;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.arc(f.x * pixW, f.y * pixH, dotRadius + age * 9 * dpr, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The newest repository's name, as canvas text. Truncated in lib/ and drawn,
    // never inserted into the document.
    if (lastName) {
      ctx.font = `${11 * dpr}px ui-monospace, "JetBrains Mono", Menlo, monospace`;
      ctx.textBaseline = "bottom";
      // A backing strip, because the name sits over the dot field and unreadable
      // text on top of dots is worse than no text.
      const w = ctx.measureText(lastName).width;
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#0d1113";
      ctx.fillRect(0, pixH - 22 * dpr, w + 16 * dpr, 22 * dpr);
      ctx.fillStyle = dimColor;
      ctx.fillText(lastName, 8 * dpr, pixH - 7 * dpr);
      ctx.globalAlpha = 1;
    }
  };

  const advanceTo = (p, now) => {
    const arrivals = tl.arrivalsBetween(progress, p);
    if (arrivals.length) {
      for (const i of arrivals) paintDot(i, 0.72);
      painted += arrivals.length;
      const from = Math.max(0, arrivals.length - MAX_FLASHES);
      for (let k = from; k < arrivals.length; k++) {
        const pos = tl.positionOf(arrivals[k]);
        pushFlash(pos.x, pos.y, now, dotColor);
      }
      lastName = tl.nameOf(arrivals[arrivals.length - 1]);
    }
    progress = p;
    readout(tl.stateAt(p));
  };

  const tick = (ts) => {
    raf = 0;
    if (!playing) return;
    const dt = lastTs ? Math.min(ts - lastTs, 250) : 0;
    lastTs = ts;
    elapsed += dt;
    // Clamped to exactly 1 rather than left at 0.9998 by a frame boundary, so
    // the last day always plays and the final frame is the full snapshot.
    const p = Math.min(1, elapsed / tl.durationMs);
    advanceTo(p, ts);
    draw(ts);
    if (p >= 1) {
      playing = false;
      // The last name drawn would otherwise sit over the finished field for as
      // long as the page is open.
      lastName = "";
      draw(ts);
      // The replay has reached today, so today is what it shows next. This is
      // the handoff: same canvas, same coordinates, no toggle to find.
      enterLive();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  const setControls = () => {
    const label = progress >= 1 ? "replay" : playing ? "pause" : "play";
    playBtn.textContent = label;
    playBtn.setAttribute("aria-label", `${label} the time-lapse`);
    playBtn.setAttribute("aria-pressed", String(playing));
    // Only the controls that mean something in the current mode are present.
    // A disabled button that still takes a tab stop is a control that lies about
    // being available.
    playBtn.hidden = live;
    restartBtn.hidden = live;
    modeBtn.textContent = live ? "replay" : "skip to live";
    modeBtn.setAttribute("aria-label", live
      ? "replay the five month time-lapse from the start"
      : "skip the replay and follow the network live");
  };

  const play = () => {
    if (progress >= 1) reset();
    playing = true;
    lastTs = 0;
    setControls();
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const pause = () => {
    playing = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    setControls();
  };

  const reset = () => {
    pause();
    elapsed = 0;
    progress = 0;
    painted = 0;
    flashes.length = 0;
    liveDots.clear();
    lastName = "";
    lastDay = lastRepos = lastAgents = -1;
    sctx.clearRect(0, 0, pixW, pixH);
    readout(tl.stateAt(0));
    draw(0);
    setControls();
  };

  // The completed picture with no playback at all: what reduced motion gets, and
  // what a visitor gets if they never press play.
  const showFinal = () => {
    pause();
    elapsed = tl.durationMs;
    progress = 0;
    painted = 0;
    sctx.clearRect(0, 0, pixW, pixH);
    flashes.length = 0;
    advanceTo(1, 0);
    lastName = "";
    draw(0);
    setControls();
  };

  // --- live ---------------------------------------------------------------
  //
  // The state this half is designed around is nothing happening. The node moves
  // about half a push a minute and touched 2 distinct repositories in the last
  // quarter of an hour, so a live panel that only knows how to say "here is what
  // just arrived" is blank most of the time, and a blank panel reads as a broken
  // one. Every render below therefore leads with two ages rather than with a
  // count: how long since the network last did anything, and how long since this
  // page last managed to ask. The second is what separates a quiet network from
  // a dead poll, and they are indistinguishable without it.

  const liveEl = $("tl-live");
  const stateEl = $("tl-live-state");
  const headlineEl = $("tl-live-headline");
  const subEl = $("tl-live-sub");
  const countsEl = $("tl-live-counts");
  const noteEl = $("tl-live-note");
  const feedEl = $("tl-live-feed");

  // Snapshot repositories by owner/name, so a live row can be matched against a
  // dot that is already on the canvas. The snapshot stores an owner index; the
  // node reports the owner DID.
  const snapRepos = Array.isArray(snapshot.repos) ? snapshot.repos : [];
  const snapOwners = Array.isArray(snapshot.owners) ? snapshot.owners : [];
  const indexByKey = new Map();
  for (let i = 0; i < snapRepos.length; i++) {
    const r = snapRepos[i];
    if (!Array.isArray(r)) continue;
    indexByKey.set(repoKey(snapOwners[r[1]], r[0]), i);
  }
  const ownerIndexByDid = new Map();
  for (let i = 0; i < snapOwners.length; i++) ownerIndexByDid.set(snapOwners[i], i);

  const MARGIN = tl.layout.margin;
  const clampUnit = (v) => Math.min(1 - MARGIN, Math.max(MARGIN, v));

  // Where a live row goes. Already in the snapshot: exactly where the replay put
  // it, which is what makes a pulse land on the right dot. New to the snapshot:
  // near its owner's existing cluster if that owner has one, otherwise on the
  // outer ring, seeded off the name so the position is stable across reloads.
  const positionFor = (key, owner) => {
    const known = indexByKey.get(key);
    if (known !== undefined) return { pos: tl.positionOf(known), fresh: false };
    const already = liveDots.get(key);
    if (already) return { pos: already, fresh: false };
    const rnd = splitmix32(hashKey(key));
    const oi = ownerIndexByDid.get(owner);
    let cx = 0.5;
    let cy = 0.5;
    let spread = 0.02;
    if (oi !== undefined && oi >= 0 && oi < tl.layout.ownerCount) {
      cx = tl.layout.centres[oi * 2];
      cy = tl.layout.centres[oi * 2 + 1];
    } else {
      // An owner with nothing in the snapshot is new to the network too, so it
      // gets its own place on the rim rather than being dropped in the middle
      // of somebody else's cluster.
      const ang = rnd() * TAU;
      const rr = (0.5 - MARGIN) * (0.82 + 0.18 * rnd());
      cx = clampUnit(0.5 + rr * Math.cos(ang));
      cy = clampUnit(0.5 + rr * Math.sin(ang));
      spread = 0.012;
    }
    const ang = rnd() * TAU;
    const rr = spread * Math.sqrt(rnd());
    const pos = { x: clampUnit(cx + rr * Math.cos(ang)), y: clampUnit(cy + rr * Math.sin(ang)) };
    return { pos, fresh: true };
  };

  let live = false;
  let pollTimer = 0;
  let clockTimer = 0;
  let polling = false;
  let prevStats = null;
  let prevRepos = null;
  let arrivedStats = null;
  // The counters as they read when the repos page was last pulled. The poll
  // decision compares against this rather than against the previous poll, so a
  // burst that lands while the once-a-minute floor is holding is still fetched
  // when the floor lifts instead of being forgotten.
  let statsAtLastRepos = null;
  let lastReposFetchAt = null;
  let lastEventAt = null;
  let lastOkAt = null;
  let nextPollAt = null;
  let failures = 0;
  let lastError = "";
  // The counters moved on a poll where the once-a-minute floor held the repos
  // page back. Without this the panel would say the counters rose and, one line
  // down, that nothing has been touched.
  let deferredChange = false;
  let started = false;
  let liveRaf = 0;
  const feed = [];

  const clearTimers = () => {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = 0; }
    if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; }
  };

  // The replay's frame loop is stopped by the time live mode runs, so an arrival
  // ring here has nothing driving it. This runs only while a ring is still
  // fading, which on this network is well under a second every few minutes.
  const animateFlashes = () => {
    liveRaf = 0;
    draw(performance.now());
    if (flashes.length) liveRaf = requestAnimationFrame(animateFlashes);
  };

  const schedule = (ms) => {
    if (pollTimer) clearTimeout(pollTimer);
    nextPollAt = Date.now() + ms;
    pollTimer = setTimeout(() => { pollTimer = 0; poll(); }, ms);
  };

  // One request, and every way it can fail collapsed into a reason string the
  // panel can show. A rejected body is never handed back as data: the proxy
  // answers a denial with {"error": "..."}, which is JSON and is an object, so
  // anything that read it optimistically would render a 502 as a network where
  // nothing happened.
  const request = async (path, kind) => {
    if (navigator.onLine === false) return { ok: false, reason: "the browser is offline" };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/net/${path}`, {
        signal: ac.signal,
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, reason: `the proxy answered ${res.status} and it was not JSON` };
      }
      const v = validatePayload(kind, body);
      if (!v.ok) return { ok: false, reason: v.reason };
      // Shape-valid but the status said otherwise. Trust the status.
      if (!res.ok) return { ok: false, reason: `the proxy answered ${res.status}` };
      return { ok: true, data: v.data };
    } catch (err) {
      const aborted = err?.name === "AbortError" || err?.name === "TimeoutError";
      return { ok: false, reason: aborted ? "no answer in 10 seconds" : "the request could not be sent" };
    } finally {
      clearTimeout(timer);
    }
  };

  const applyChanges = (changes) => {
    const now = performance.now();
    for (const c of changes.changed) {
      const { pos, fresh } = positionFor(c.key, c.owner);
      if (fresh) {
        liveDots.set(c.key, pos);
        paintAt(pos.x, pos.y, 0.85, dotColor);
        pushFlash(pos.x, pos.y, now, dotColor);
      } else {
        // Already a dot on this canvas. A second push is not a second object, so
        // nothing is added; the existing dot pulses in the second accent.
        pushFlash(pos.x, pos.y, now, pulseColor);
      }
      feed.unshift(c);
    }
    feed.length = Math.min(feed.length, FEED_MAX);
    if (!changes.changed.length) return;
    draw(now);
    if (flashes.length && !liveRaf) liveRaf = requestAnimationFrame(animateFlashes);
  };

  const poll = async () => {
    if (!live || polling || document.hidden) return;
    polling = true;
    try {
      const before = prevStats;
      const s = await request("stats", "stats");
      if (!s.ok) { failPoll(s.reason); return; }

      const now = Date.now();
      const moved = diffStats(before, s.data);
      // The counter moving is itself an observed event, and it is the only
      // evidence available on the polls where the repos page is not fetched.
      if (moved.moved) lastEventAt = now;
      const wantRepos = shouldFetchRepos({
        statsAtLastFetch: statsAtLastRepos, nextStats: s.data, lastReposFetchAt, now,
      });
      if (moved.moved && !wantRepos) deferredChange = true;
      prevStats = s.data;
      if (!arrivedStats) arrivedStats = s.data;
      failures = 0;
      lastError = "";
      lastOkAt = now;

      if (wantRepos) {
        const r = await request(`repos?limit=${REPOS_LIMIT}`, "repos");
        // A stats poll that worked and a repos poll that did not is still a
        // failed poll: the panel would otherwise show fresh counters and a feed
        // that silently stopped listing what moved.
        if (!r.ok) { failPoll(r.reason); return; }
        lastReposFetchAt = now;
        statsAtLastRepos = s.data;
        deferredChange = false;
        const changes = diffRepos(prevRepos, r.data);
        prevRepos = r.data;
        if (changes.newest !== null && (lastEventAt === null || changes.newest > lastEventAt)) {
          lastEventAt = changes.newest;
        }
        applyChanges(changes);
      }
      renderLive();
      schedule(POLL_MS);
    } finally {
      polling = false;
    }
  };

  const failPoll = (reason) => {
    failures++;
    lastError = reason;
    renderLive();
    schedule(nextBackoffMs(failures));
  };

  const setText = (n, s) => { if (n.textContent !== s) n.textContent = s; };

  const renderLive = () => {
    if (!live) return;
    const now = Date.now();
    const broken = failures > 0;
    const offline = navigator.onLine === false;

    if (offline || broken) {
      // The requirement this whole panel is built around. A poll that failed
      // must never look like a poll that succeeded and found nothing, so the
      // headline stops being an age and starts being the fault, the state chip
      // changes colour, and the counters below are labelled as of when they were
      // actually read.
      stateEl.className = "tl-live-state down";
      setText(stateEl, offline ? "offline" : "not connected");
      setText(headlineEl, offline
        ? "This browser is offline"
        : "Not connected to the node");
      const retry = nextPollAt ? Math.max(0, Math.round((nextPollAt - now) / 1000)) : null;
      setText(subEl, [
        lastOkAt ? `last answer ${formatAge(lastOkAt, now)}` : "no answer yet",
        retry === null ? null : `retrying in ${retry}s`,
      ].filter(Boolean).join("  ·  "));
      setText(noteEl, offline
        ? "Nothing below is updating. It will pick up again when the connection comes back."
        : `The last poll failed: ${lastError}. Nothing below is updating, so read the ` +
          "counters as of the last answer rather than as now. This is a fault on the way to " +
          "the node, not a quiet network.");
    } else if (!lastOkAt) {
      // The first request is in flight and can stay that way for the full ten
      // second timeout. Nothing here may suggest an answer has come back.
      stateEl.className = "tl-live-state waiting";
      setText(stateEl, "connecting");
      setText(headlineEl, "Asking the node...");
      setText(subEl, "waiting for the first answer");
      setText(noteEl, "");
    } else {
      stateEl.className = "tl-live-state up";
      setText(stateEl, "live");
      setText(headlineEl, lastEventAt === null
        ? "No event observed yet"
        : `Last event ${formatAge(lastEventAt, now)}`);
      setText(subEl, `checked ${formatAge(lastOkAt, now)}  ·  polling every ${POLL_MS / 1000}s`);
      const quiet = lastEventAt !== null && now - lastEventAt > QUIET_MS;
      setText(noteEl, quiet
        ? "Nothing has moved for a while. That is the normal state of this network: it runs at " +
          "about one push every two minutes and touched two distinct repositories in the last " +
          "quarter of an hour. The check above is what tells you the page is still working."
        : "");
    }

    // Counters. Present in every state, including the broken one, where the
    // heading says plainly that they are the last known values.
    countsEl.replaceChildren();
    if (prevStats) {
      const since = diffStats(arrivedStats, prevStats);
      const cells = [
        [formatCount(prevStats.pushes), "pushes", since.pushes > 0 ? `+${formatCount(since.pushes)} since you arrived` : null],
        [formatCount(prevStats.repos), "repos", since.repos > 0 ? `+${formatCount(since.repos)} since you arrived` : null],
        [formatCount(prevStats.agents), "agents", since.agents > 0 ? `+${formatCount(since.agents)} since you arrived` : null],
      ];
      for (const [value, label, sub] of cells) {
        const cell = el("div", "tl-live-cell");
        cell.append(el("span", "tl-live-value", value));
        cell.append(el("span", "tl-live-label", label));
        if (sub) cell.append(el("span", "tl-live-delta", sub));
        countsEl.append(cell);
      }
    }

    // The feed. Names come off a public network, so every one of them is set as
    // textContent on an element created here.
    // "No repository has been touched" is a claim about the network, and it can
    // only be made once the node has actually answered. Before that, and after a
    // failure, saying it would be the exact bug this panel is designed against:
    // a broken poll that reads as a quiet network.
    feedEl.replaceChildren();
    if (!feed.length) {
      const empty = broken || offline
        ? "The list of what moved is not being updated."
        : !lastOkAt
          ? "Waiting for the first answer, so nothing is known yet."
          : deferredChange
            ? "The counters moved. Which repositories moved with them is fetched at most once a minute, so this list is a moment behind."
            : "No repository has been touched since this page connected.";
      feedEl.append(el("p", "tl-live-empty", empty));
    } else {
      for (const c of feed) {
        const rowEl = el("div", "tl-live-row");
        rowEl.append(el("span", `tl-live-kind${c.isNew ? " new" : ""}`, c.isNew ? "new" : "push"));
        rowEl.append(el("span", "tl-live-name", c.name));
        const meta = [
          c.owner ? truncateDid(c.owner, 10, 6) : null,
          formatAge(c.at, now),
        ].filter(Boolean).join("  ·  ");
        rowEl.append(el("span", "tl-live-meta", meta));
        feedEl.append(rowEl);
      }
    }
  };

  const enterLive = () => {
    if (live) return;
    live = true;
    started = true;
    pause();
    // Finish the field first, so live mode draws onto the completed picture and
    // not onto whatever fraction of the replay had run.
    if (progress < 1) advanceTo(1, performance.now());
    lastName = "";
    draw(performance.now());
    // Catching up to today pushes an arrival ring for the last of those repos,
    // and the replay's frame loop has just been stopped, so nothing would clear
    // them: skipping to live left about ninety rings frozen on the field until
    // the next event happened to force a redraw. Found by counting lit pixels
    // before and after a scripted burst.
    if (flashes.length && !liveRaf) liveRaf = requestAnimationFrame(animateFlashes);
    dateOut.textContent = "live";
    fill.style.width = "100%";
    bar.setAttribute("aria-valuenow", 100);
    bar.setAttribute("aria-valuetext", "replay finished, following the network live");
    liveEl.hidden = false;
    setControls();
    renderLive();
    // The ages on screen have to keep counting between polls. Without this the
    // panel would sit on "last event 4 minutes ago" for thirty seconds at a
    // time, which is the frozen look the whole panel exists to avoid.
    if (!clockTimer) clockTimer = setInterval(renderLive, 1000);
    poll();
  };

  const leaveLive = () => {
    live = false;
    clearTimers();
    prevStats = null;
    prevRepos = null;
    arrivedStats = null;
    statsAtLastRepos = null;
    lastReposFetchAt = null;
    lastEventAt = null;
    lastOkAt = null;
    nextPollAt = null;
    failures = 0;
    lastError = "";
    deferredChange = false;
    feed.length = 0;
    liveEl.hidden = true;
    reset();
    if (reduced) showFinal(); else play();
  };

  // A backgrounded tab must not be a standing load on the node. The counters it
  // would have collected are worth nothing to a visitor who is not looking, and
  // the first poll on return refreshes everything anyway.
  document.addEventListener("visibilitychange", () => {
    if (!live) return;
    if (document.hidden) {
      clearTimers();
      return;
    }
    if (!clockTimer) clockTimer = setInterval(renderLive, 1000);
    poll();
  });

  // --- controls -----------------------------------------------------------

  // Autoplay fires once, when the section first reaches the viewport. Anyone who
  // touched the controls has already started the replay themselves, so this flag
  // has to be set here too. Without it, clicking play while the section is still
  // below the autoplay threshold and watching the run finish gets you a second,
  // unrequested replay the moment you scroll down to it.
  playBtn.addEventListener("click", () => {
    started = true;
    if (playing) pause(); else play();
  });
  restartBtn.addEventListener("click", () => { started = true; reset(); play(); });
  modeBtn.addEventListener("click", () => {
    if (live) leaveLive(); else enterLive();
  });

  resize();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(resize).observe(canvas);
  } else {
    window.addEventListener("resize", resize);
  }

  if (reduced) {
    // No autoplay and no automatic handoff to live: both are motion nobody
    // asked for. Both buttons still work.
    showFinal();
    return;
  }

  reset();

  // Autoplay only once the section is actually on screen. A 35 second replay
  // that finished while the visitor was still reading the counters is a demo
  // nobody saw.
  const start = () => {
    if (started) return;
    started = true;
    play();
  };
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { io.disconnect(); start(); }
      }
    }, { threshold: 0.35 });
    io.observe(canvas);
  } else {
    start();
  }
}
