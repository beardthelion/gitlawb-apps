// The Push Wall: render one crawled snapshot of the Gitlawb network.
//
// Static by design. The measured rate of the network is roughly a dozen visible
// events per day (see plans/push-wall.md), so there is nothing to stream and a
// ticker would read as broken software. The accumulated totals are the story.
//
// Security posture: every string below (repo names, owner DIDs, capability
// strings, ref names, peer hostnames) comes off a public network that anyone can
// write to. None of it is trusted. There is no innerHTML anywhere in this file;
// text reaches the document through textContent and elements are created one at
// a time. The only places a value influences markup rather than text are
// numeric: a bar's style.width and the SVG path coordinates, both built from
// numbers that came out of arithmetic in derive.js.

import {
  formatCount, formatUtc, dayLabel, truncateDid,
  dailyNewRepos, dailyFromPairs, cumulative, peakDay,
  topOwners, topCapabilities, sortedPeers, recentEvents, splitRepoId,
} from "./lib/derive.js";
import { renderTimelapse } from "./timelapse-canvas.js";

const SNAPSHOT_URL = "./data/snapshot.json";
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// SVG presentation attributes do not resolve CSS custom properties, so a
// `stroke` that names a palette variable is set through the style property
// instead, where var() does resolve. Everything else is a plain attribute.
const svgNode = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "stroke" || k === "fill") n.style.setProperty(k, String(v));
    else n.setAttribute(k, String(v));
  }
  return n;
};

// --- loading -------------------------------------------------------------

// A snapshot that will not load has to say so. The alternative, an empty shell
// or a grid of NaN, looks like the network is dead rather than like the page
// failed, and that is the one wrong impression this page must not give.
function showError(reason) {
  const status = $("status");
  status.className = "status error";
  status.textContent = `Could not load the network snapshot: ${reason}. ` +
    "Nothing below is real, so nothing is shown. Reload, or read the numbers " +
    "straight from node.gitlawb.com.";
  status.hidden = false;
  $("content").hidden = true;
}

async function loadSnapshot(url = SNAPSHOT_URL) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // res.json() throws a SyntaxError on a truncated or non-JSON body, which is
  // exactly the case a half-written snapshot produces.
  const data = await res.json();
  if (!data || typeof data !== "object" || !Array.isArray(data.repos) || !data.stats) {
    throw new Error("the file loaded but is not a snapshot");
  }
  return data;
}

// --- counters ------------------------------------------------------------

function renderCounters(s) {
  const host = $("counters");
  const peers = s.peers ?? { count: 0, reachable: 0 };
  const cards = [
    { value: s.stats.repos, label: "repositories" },
    { value: s.stats.agents, label: "agents" },
    { value: s.stats.pushes, label: "pushes" },
    { value: peers.count, label: "peers", sub: `${formatCount(peers.reachable)} answering` },
    { value: Array.isArray(s.owners) ? s.owners.length : 0, label: "distinct owners" },
  ];
  for (const c of cards) {
    const box = node("div", "counter");
    box.append(node("div", "counter-value", formatCount(c.value)));
    box.append(node("div", "counter-label", c.label));
    if (c.sub) box.append(node("div", "counter-sub", c.sub));
    host.append(box);
  }

  const days = Number(s.day_count) || 0;
  $("counter-note").textContent =
    `Everything here was built in ${formatCount(days)} days, starting ` +
    `${dayLabel(s.day_base, 0)}. The push count is the node's own tally; the ` +
    "ref-update list further down is a separate, much smaller gossip feed.";
}

// --- growth curve --------------------------------------------------------

const VB_W = 1000;
const VB_H = 300;
const PAD_T = 12;
const PAD_B = 8;

function seriesPath(values, max, w = VB_W, h = VB_H) {
  const n = values.length;
  if (n === 0 || max <= 0) return "";
  const inner = h - PAD_T - PAD_B;
  const x = (i) => (n === 1 ? 0 : (i * w) / (n - 1));
  const y = (v) => h - PAD_B - (v / max) * inner;
  let d = `M ${x(0).toFixed(2)} ${y(values[0]).toFixed(2)}`;
  for (let i = 1; i < n; i++) d += ` L ${x(i).toFixed(2)} ${y(values[i]).toFixed(2)}`;
  return d;
}

function renderGrowth(s) {
  const host = $("growth");
  const days = Number(s.day_count) || 0;
  const dailyR = dailyNewRepos(s.repos, days);
  const dailyA = dailyFromPairs(s.agents?.daily, days);
  const cumR = cumulative(dailyR);
  const cumA = cumulative(dailyA);
  const totalR = cumR[cumR.length - 1] ?? 0;
  const totalA = cumA[cumA.length - 1] ?? 0;
  const max = Math.max(totalR, totalA, 1);
  const peak = peakDay(dailyR);

  const frame = node("div", "chart-frame");

  const head = node("div", "chart-head");
  head.append(node("span", null, `${formatCount(max)} cumulative`));
  head.append(node("span", null, "0 at the baseline"));
  frame.append(head);

  // role=img plus a label that carries the same numbers the curve draws, so the
  // chart is not a hole in the page for anything that does not render SVG.
  const svg = svgNode("svg", {
    viewBox: `0 0 ${VB_W} ${VB_H}`,
    role: "img",
    "aria-labelledby": "growth-title growth-desc",
  });
  const title = svgNode("title", { id: "growth-title" });
  title.textContent = "Cumulative repositories and agents by day";
  const desc = svgNode("desc", { id: "growth-desc" });
  desc.textContent =
    `Two rising curves over ${formatCount(days)} days, from ${dayLabel(s.day_base, 0)} ` +
    `to ${dayLabel(s.day_base, days - 1)}. Repositories reach ${formatCount(totalR)} ` +
    `and agents reach ${formatCount(totalA)}.` +
    (peak ? ` The largest single day added ${formatCount(peak.count)} repositories on ${dayLabel(s.day_base, peak.index)}.` : "");
  svg.append(title, desc);

  for (const frac of [0.25, 0.5, 0.75]) {
    const y = VB_H - PAD_B - frac * (VB_H - PAD_T - PAD_B);
    svg.append(svgNode("line", {
      x1: 0, x2: VB_W, y1: y, y2: y, stroke: "var(--line)", "stroke-width": 1,
      "vector-effect": "non-scaling-stroke",
    }));
  }

  if (peak) {
    const x = (peak.index * VB_W) / Math.max(1, days - 1);
    svg.append(svgNode("line", {
      x1: x, x2: x, y1: 0, y2: VB_H, stroke: "#3a4a4d", "stroke-width": 1,
      "stroke-dasharray": "3 4", "vector-effect": "non-scaling-stroke",
    }));
    const yPeak = VB_H - PAD_B - (cumR[peak.index] / max) * (VB_H - PAD_T - PAD_B);
    svg.append(svgNode("circle", { cx: x, cy: yPeak, r: 4, fill: "var(--accent)" }));
  }

  // Agents dashed and thinner, repos solid and heavier, so the two series stay
  // apart in greyscale and for anyone who cannot separate cyan from orange.
  svg.append(svgNode("path", {
    d: seriesPath(cumA, max), fill: "none", stroke: "var(--accent2)",
    "stroke-width": 1.5, "stroke-dasharray": "6 5", "vector-effect": "non-scaling-stroke",
  }));
  svg.append(svgNode("path", {
    d: seriesPath(cumR, max), fill: "none", stroke: "var(--accent)",
    "stroke-width": 2.5, "vector-effect": "non-scaling-stroke",
  }));
  frame.append(svg);

  const axis = node("div", "chart-axis");
  axis.append(node("span", null, dayLabel(s.day_base, 0)));
  axis.append(node("span", null, dayLabel(s.day_base, days - 1)));
  frame.append(axis);

  const legend = node("div", "legend");
  legend.append(legendItem("var(--accent)", 2.5, null, `repositories, ${formatCount(totalR)} total`));
  legend.append(legendItem("var(--accent2)", 1.5, "6 5", `agents, ${formatCount(totalA)} total`));
  frame.append(legend);

  host.append(frame);

  const caption = node("p", "chart-caption");
  if (peak) {
    caption.append(document.createTextNode("The biggest day on record is "));
    caption.append(node("strong", null, dayLabel(s.day_base, peak.index)));
    caption.append(document.createTextNode(
      `, when ${formatCount(peak.count)} repositories appeared at once, marked on the curve. ` +
      "Both series only ever rise: the snapshot records creations, and nothing in it deletes."));
  } else {
    caption.textContent = "Both series only ever rise: the snapshot records creations, and nothing in it deletes.";
  }
  host.append(caption);
}

function legendItem(stroke, width, dash, label) {
  const item = node("div", "legend-item");
  const swatch = svgNode("svg", { class: "legend-swatch", width: 34, height: 10, "aria-hidden": "true" });
  const attrs = { x1: 0, x2: 34, y1: 5, y2: 5, stroke, "stroke-width": width };
  if (dash) attrs["stroke-dasharray"] = dash;
  swatch.append(svgNode("line", attrs));
  item.append(swatch, node("span", null, label));
  return item;
}

// --- proportional rows ---------------------------------------------------

function barRow(label, countText, fraction, alt = false) {
  const row = node("div", "row");
  row.append(node("div", "row-label", label));
  row.append(node("div", "row-count", countText));
  const bar = node("div", "row-bar");
  const fill = node("span", `row-bar-fill${alt ? " alt" : ""}`);
  // A width percentage computed from a count. Numeric, never a snapshot string.
  fill.style.width = `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(2)}%`;
  bar.append(fill);
  row.append(bar);
  return row;
}

function renderOwners(s) {
  const host = $("owners");
  for (const o of topOwners(s, 12)) {
    const pct = (o.share * 100).toFixed(1);
    const row = barRow(o.short, `${formatCount(o.count)} repos, ${pct}%`, o.fraction);
    // The full DID on hover, still as text, for anyone who wants to look it up.
    row.title = o.did;
    host.append(row);
  }
}

function renderCapabilities(s) {
  const host = $("caps");
  const { top, tailKinds, tailClaims } = topCapabilities(s.agents?.capabilities, 6);
  for (const c of top) host.append(barRow(c.name, formatCount(c.count), c.fraction, true));
  $("caps-tail").textContent = tailKinds > 0
    ? `Another ${formatCount(tailKinds)} capability strings appear across ${formatCount(tailClaims)} ` +
      "claims between them, too rare to be worth a row each."
    : "Every capability string in the snapshot is listed above.";
}

// --- peers ---------------------------------------------------------------

function renderPeers(s) {
  const host = $("peers");
  const peers = sortedPeers(s);
  const up = peers.filter((p) => p.reachable);
  const down = peers.filter((p) => !p.reachable);

  const group = (title, rows) => {
    if (!rows.length) return;
    host.append(node("h3", "peer-group-title", title));
    const strip = node("div", "peer-strip");
    for (const p of rows) {
      const chip = node("div", `peer${p.reachable ? " up" : ""}`);
      // Filled circle for answering, hollow for not. The glyph carries the
      // state; the colour only reinforces it.
      chip.append(node("span", "peer-mark", p.reachable ? "●" : "○"));
      chip.append(node("span", null, p.label || "unknown"));
      strip.append(chip);
    }
    host.append(strip);
  };

  group(`answering (${formatCount(up.length)})`, up);
  group(`listed but not answering (${formatCount(down.length)})`, down);

  const note = node("p", "fine");
  note.textContent =
    `${formatCount(peers.length)} peers are known to this node and ${formatCount(up.length)} ` +
    "answered when the crawl ran. The rest are addresses the mesh still carries, which is " +
    "what a gossip network looks like rather than a fault.";
  host.append(note);
}

// --- events --------------------------------------------------------------

function renderEvents(s) {
  const host = $("events");
  const rows = recentEvents(s, 12);
  if (!rows.length) {
    host.append(node("p", "fine", "The snapshot carries no ref updates."));
    return;
  }
  for (const e of rows) {
    const { owner, name } = splitRepoId(e.repo);
    const row = node("div", "event");
    row.append(node("span", `event-kind${e.created ? " created" : ""}`, e.created ? "create" : "update"));
    row.append(node("span", "event-repo", name || e.repo));
    // A collapsed run reads as a span, so it shows both ends rather than only
    // the newest timestamp, which would make eleven pushes look like one. The
    // comparison is on the formatted strings, not the raw ones: these land
    // seconds apart, and "20:02 UTC to 20:02 UTC" is noise.
    const newest = e.at ? formatUtc(e.at) : null;
    const oldest = e.since ? formatUtc(e.since) : null;
    const when = newest && oldest && oldest !== newest ? `${oldest} to ${newest}` : newest;
    const meta = [
      e.ref,
      e.count > 1 ? `${formatCount(e.count)} pushes` : null,
      owner ? `owner ${truncateDid(owner, 10, 6)}` : null,
      e.pusher ? `pusher ...${e.pusher}` : null,
      when,
    ].filter(Boolean).join("  ·  ");
    row.append(node("span", "event-meta", meta));
    host.append(row);
  }
}

// --- footer --------------------------------------------------------------

function renderFooter(s) {
  $("footer-meta").textContent =
    `Snapshot taken ${formatUtc(s.generated_at)} from node version ${String(s.stats.version ?? "unknown")}. `;
}

// --- boot ----------------------------------------------------------------

// One ordered list of render steps over one snapshot. The time-lapse is the
// exception at the end: it needs the section to have a measurable width before
// it can size a canvas, so it runs after the content is shown.
export async function boot() {
  let snapshot;
  try {
    snapshot = await loadSnapshot();
  } catch (err) {
    showError(err?.message ?? String(err));
    return;
  }
  try {
    renderCounters(snapshot);
    renderGrowth(snapshot);
    renderOwners(snapshot);
    renderPeers(snapshot);
    renderCapabilities(snapshot);
    renderEvents(snapshot);
    renderFooter(snapshot);
  } catch (err) {
    // A snapshot that parsed but is shaped wrong lands here. Same rule: say it
    // rather than leave half a page of panels standing.
    showError(`the snapshot is missing something the page needs (${err?.message ?? err})`);
    return;
  }
  $("status").hidden = true;
  $("content").hidden = false;

  // Last, and after the unhide, because the canvas measures itself and a hidden
  // element measures zero. Its own try: a failure here should cost the replay,
  // not blank a page of correctly rendered panels.
  try {
    renderTimelapse(snapshot);
  } catch (err) {
    $("tl-alt").textContent =
      `The replay could not start (${err?.message ?? err}). Every number it would ` +
      "have shown is in the sections below.";
  }
}

boot();
