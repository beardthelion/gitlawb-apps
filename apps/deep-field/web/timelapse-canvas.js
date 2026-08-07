// The canvas half of the time-lapse. Everything it draws comes out of
// lib/timelapse.js; this file owns pixels, the frame loop, and the controls, and
// no arithmetic about the network.
//
// Security posture matches the rest of the page: nothing from the snapshot
// reaches the document through innerHTML. The only snapshot-derived string that
// leaves lib/ at all is a repo name, and it is drawn with fillText onto a
// canvas, where it is glyphs rather than markup. Readout text goes in through
// textContent; the two style properties written here are numeric widths.

import { formatCount, dayLabel } from "./lib/derive.js";
import { createTimelapse, DEFAULT_DURATION_MS } from "./lib/timelapse.js";

const TAU = Math.PI * 2;
const FLASH_MS = 700;
// A busy frame on the 978-repo day can bring in a hundred arrivals at once.
// Every one of them gets its dot, but only the most recent get a flash ring, so
// the per-frame cost stays flat instead of tracking the burst.
const MAX_FLASHES = 90;

const $ = (id) => document.getElementById(id);

const cssColor = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
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

  // --- the text alternative ---------------------------------------------
  // A canvas is a hole in the page for anything that does not look at it, so the
  // same outcome is stated in prose and as the canvas label.
  const summary =
    `A replay of ${formatCount(tl.dayCount)} days, ${dayLabel(dayBase, 0)} to ` +
    `${dayLabel(dayBase, tl.dayCount - 1)}. One dot per repository, placed near the ` +
    `other repositories of its owner, appearing on the day it was created. It ends at ` +
    `${formatCount(tl.totalRepos)} repositories across ` +
    `${formatCount(Array.isArray(snapshot.owners) ? snapshot.owners.length : 0)} owners, ` +
    `alongside ${formatCount(tl.totalAgents)} registered agents.`;
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

  const paintDot = (i, alpha = 1) => {
    const p = tl.positionOf(i);
    sctx.globalAlpha = alpha;
    sctx.fillStyle = dotColor;
    sctx.beginPath();
    sctx.arc(p.x * pixW, p.y * pixH, dotRadius, 0, TAU);
    sctx.fill();
    sctx.globalAlpha = 1;
  };

  const repaintAll = () => {
    sctx.clearRect(0, 0, pixW, pixH);
    for (let k = 0; k < painted; k++) paintDot(tl.order[k], 0.72);
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

  const draw = (now = 0) => {
    if (pixW === 0) return;
    ctx.clearRect(0, 0, pixW, pixH);
    ctx.drawImage(settled, 0, 0);

    for (let k = flashes.length - 1; k >= 0; k--) {
      const f = flashes[k];
      const age = (now - f.t) / FLASH_MS;
      if (age >= 1 || age < 0) { flashes.splice(k, 1); continue; }
      const p = tl.positionOf(f.i);
      ctx.globalAlpha = (1 - age) * 0.9;
      ctx.strokeStyle = dotColor;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.arc(p.x * pixW, p.y * pixH, dotRadius + age * 9 * dpr, 0, TAU);
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
      for (let k = from; k < arrivals.length; k++) flashes.push({ i: arrivals[k], t: now });
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
      setPlayLabel();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  const setPlayLabel = () => {
    const label = progress >= 1 ? "replay" : playing ? "pause" : "play";
    playBtn.textContent = label;
    playBtn.setAttribute("aria-label", `${label} the time-lapse`);
    playBtn.setAttribute("aria-pressed", String(playing));
  };

  const play = () => {
    if (progress >= 1) reset();
    playing = true;
    lastTs = 0;
    setPlayLabel();
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const pause = () => {
    playing = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    setPlayLabel();
  };

  const reset = () => {
    pause();
    elapsed = 0;
    progress = 0;
    painted = 0;
    flashes.length = 0;
    lastName = "";
    lastDay = lastRepos = lastAgents = -1;
    sctx.clearRect(0, 0, pixW, pixH);
    readout(tl.stateAt(0));
    draw(0);
    setPlayLabel();
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
    setPlayLabel();
  };

  // Autoplay fires once, when the section first reaches the viewport. Anyone who
  // touched the controls has already started the replay themselves, so this flag
  // has to be set here too. Without it, clicking play while the section is still
  // below the autoplay threshold and watching the run finish gets you a second,
  // unrequested replay the moment you scroll down to it.
  let started = false;

  playBtn.addEventListener("click", () => {
    started = true;
    if (playing) pause(); else play();
  });
  restartBtn.addEventListener("click", () => { started = true; reset(); play(); });

  resize();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(resize).observe(canvas);
  } else {
    window.addEventListener("resize", resize);
  }

  if (reduced) {
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
