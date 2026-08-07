// Deep Field: render one crawled snapshot of the Gitlawb network.
//
// Static by design. The measured rate of the network is roughly a dozen visible
// events per day (see plans/deep-field.md), so there is nothing to stream and a
// ticker would read as broken software. The accumulated totals are the story.
//
// Security posture: every string below (repo names, owner DIDs, capability
// strings) comes off a public network that anyone can write to. None of it is
// trusted. There is no innerHTML anywhere in this file;
// text reaches the document through textContent and elements are created one at
// a time. The only places a value influences markup rather than text are
// numeric: a bar's style.width and the SVG path coordinates, both built from
// numbers that came out of arithmetic in derive.js.

import {
  formatCount, formatUtc, dayLabel,
  dailyNewRepos, dailyFromPairs, cumulative, peakDay,
  topOwners, topCapabilities,
  topFamilies, repoActivity, ownerLifetimeSummary,
  activitySummary, cellIntensity, weekdayLabel, weekdayName, hourLabel, batchLabel,
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
  // The growth curve, the time-lapse, and the owner shares all count
  // `s.repos`, the rows the crawl actually collected, so the headline
  // repositories figure has to come from the same array or the page can print
  // two different totals for the same network. `s.stats.repos` is the node's
  // own tally, copied by the crawler rather than measured from the rows, and
  // crawl.mjs already logs (but does not block on) the two drifting apart. It
  // is still worth showing, just not as the headline: when it disagrees with
  // the row count, that disagreement is crawl drift, not two contradictory
  // facts about the network.
  const repoCount = Array.isArray(s.repos) ? s.repos.length : 0;
  const repoCard = { value: repoCount, label: "repositories" };
  if (Number.isFinite(s.stats.repos) && s.stats.repos !== repoCount) {
    repoCard.sub = `node reports ${formatCount(s.stats.repos)}`;
  }
  const cards = [
    repoCard,
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
    `${dayLabel(s.day_base, 0)}. The push count is the node's own tally, which ` +
    "is far larger than the gossip feed any single node overhears from its peers.";
}

// The tagline and the time-lapse progress bar carry the same figures as the
// counters above, but they are markup written before this script runs, not
// generated by it, so a re-crawl leaves them stating stale numbers unless
// something goes back and updates them. The literals stay in the HTML as the
// pre-JavaScript fallback; this overwrites them once the real snapshot is in
// hand.
function renderTagline(s) {
  const repoCount = Array.isArray(s.repos) ? s.repos.length : 0;
  $("tagline-repos").textContent = formatCount(repoCount);
  $("tagline-agents").textContent = formatCount(s.stats.agents);

  const days = Number(s.day_count) || 0;
  $("tl-progress").setAttribute("aria-label", `Replay position across the ${formatCount(days)} days`);
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

// Repository names are the most attacker-controlled strings on this page: anyone
// can create a repo on this network and call it whatever they like. Every one
// below goes through barRow, which sets textContent. Nothing here builds markup
// from a name.
function renderFamilies(s) {
  const host = $("families");
  const f = topFamilies(s, 12);
  for (const fam of f.top) {
    // Repos and owners side by side, because the two numbers matching is the
    // claim. 17 repos from 17 owners is separate agents landing on the same idea;
    // 17 from 1 is one account, and the row says which without the reader having
    // to take the section's word for it.
    // Days is the column that decides what this section may claim. 18 repos from
    // 18 owners looks like independent convergence until you see they all landed
    // on one day, which makes it a batch.
    const count = `${formatCount(fam.count)} repos, ` +
      (fam.owners === 1 ? "1 owner" : `${formatCount(fam.owners)} owners`) +
      ", " + (fam.days === 1 ? "1 day" : `${formatCount(fam.days)} days`);
    host.append(barRow(fam.name || "(no name)", count, fam.fraction));
  }

  $("families-tail").textContent =
    `${formatCount(f.total)} repositories carry ${formatCount(f.familyCount)} distinct names ` +
    `once instance markers come off, and ${formatCount(f.singletons)} of those names occur ` +
    `exactly once. Against that pile, ${formatCount(f.repeated)} ideas were built ` +
    `${formatCount(f.repeatAt)} or more times each, usually by a different owner every time. ` +
    "Watch the day count rather than the repo count. The tutors, the trackers and the " +
    "safety monitors each come from a different owner, which looks like separate agents " +
    "reaching the same idea, but every one of them was created on a single day: they are " +
    "one batch wearing many names. Of the families holding five repositories or more, most " +
    "are that shape. What genuinely repeats is the dull end of the list. my-first-repo is " +
    "219 repositories from 219 owners spread across 47 separate days, which is five months " +
    "of people turning up and doing the tutorial.";

  const a = repoActivity(s);
  const pct = a.total > 0 ? Math.round((a.untouched / a.total) * 100) : 0;
  $("families-activity").textContent =
    `Almost none of it is read. ${formatCount(a.starred)} of ${formatCount(a.total)} ` +
    `repositories have even one star and ${formatCount(a.forked)} are forks. ` +
    `${formatCount(a.untouched)} of them, ${pct}%, show no activity after the day they were ` +
    "created. The snapshot records days rather than timestamps, so a repo created and " +
    `pushed to within its first day is counted here too, which makes ` +
    `${formatCount(a.untouched)} an upper bound on how many were built and abandoned.`;
}

// --- punchcard -----------------------------------------------------------

// Which hour columns get a printed label. Every third would collide at 360px,
// where a column is about nine pixels wide, so this is the four quarter marks
// plus the last hour, which is the one that shows the fall back to the trough.
const HOUR_TICKS = [0, 6, 12, 18, 23];

// A CSS grid rather than a canvas or a fixed-viewBox SVG. The columns are
// fractional, so 24 of them divide whatever width there is instead of forcing a
// scrollbar at 360px, and the labels stay real text at a real font size instead
// of scaling with a viewBox.
function renderPunchcard(s) {
  const host = $("punchcard");
  const a = activitySummary(s);
  if (!a) {
    $("punchcard-alt").textContent =
      "This snapshot carries no hour-of-day breakdown, so the punchcard is not shown.";
    return;
  }

  const peakWhen = `${weekdayName(a.peakCell.day)} ${hourLabel(a.peakCell.hour)} UTC`;
  const busiest = `${hourLabel(a.busiestHour.hour)} UTC`;
  const quietest = `${hourLabel(a.quietestHour.hour)} UTC`;
  const swing = a.swing.toFixed(1);
  const weekdayMean = formatCount(Math.round(a.weekdayMean));
  const weekendMean = formatCount(Math.round(a.weekendMean));

  const frame = node("div", "chart-frame");

  // One label for the whole lattice. 168 cells read out one at a time is not a
  // description of anything, so the grid is a single image and the sentence below
  // carries the same numbers.
  const grid = node("div", "pc-grid");
  grid.setAttribute("role", "img");
  grid.setAttribute("aria-label",
    `Repository creations by UTC weekday and hour. The busiest hour of the day is ${busiest} ` +
    `with ${formatCount(a.busiestHour.count)} repositories and the quietest is ${quietest} with ` +
    `${formatCount(a.quietestHour.count)}. Weekdays average ${weekdayMean} and weekend days ${weekendMean}.`);

  for (let d = 0; d < a.grid.length; d++) {
    grid.append(node("div", "pc-day", weekdayLabel(d)));
    for (let h = 0; h < 24; h++) {
      const count = a.grid[d][h];
      const cell = node("div", "pc-cell");
      // Both channels move together: alpha for colour vision, side length for
      // everyone else. In greyscale the alpha collapses towards the panel and the
      // size is what is left carrying the shape.
      const i = cellIntensity(count, a.max);
      const dot = node("span", "pc-dot");
      const side = (24 + i * 76).toFixed(1);
      dot.style.width = `${side}%`;
      dot.style.height = `${side}%`;
      dot.style.opacity = (0.22 + i * 0.78).toFixed(3);
      if (count === 0) dot.classList.add("empty");
      cell.append(dot);
      // Every square is checkable on its own, which is the only thing that makes
      // a heatmap auditable.
      cell.title = `${weekdayName(d)} ${hourLabel(h)} UTC: ` +
        `${formatCount(count)} ${count === 1 ? "repository" : "repositories"}`;
      grid.append(cell);
    }
  }
  frame.append(grid);

  // The marginal totals, and the grid needs them to be honest. The finding is a
  // 2.8x swing across the day, but it lives in the column sums: a single square
  // holds 11 repositories at the median and 48 at most, so 168 of them scaled
  // against each other come out nearly identical and the climb the caption
  // describes is invisible. Summing each hour down its column is where the shape
  // actually is, so it gets drawn rather than only asserted underneath.
  const hourMax = Math.max(...a.hours, 1);
  const totals = node("div", "pc-totals");
  totals.setAttribute("role", "img");
  totals.setAttribute("aria-label",
    `Repository creations summed by hour of day, ${formatCount(a.quietestHour.count)} at ` +
    `${quietest} rising to ${formatCount(a.busiestHour.count)} at ${busiest}.`);
  totals.append(node("div", "pc-day"));
  for (let h = 0; h < 24; h++) {
    const n = a.hours[h];
    const col = node("div", "pc-bar");
    const fill = node("span", "pc-bar-fill");
    // Linear against the column max, not sqrt. These are the numbers the reader
    // is being asked to compare, so the bar heights have to be the real ratio.
    fill.style.height = `${((n / hourMax) * 100).toFixed(1)}%`;
    if (h === a.busiestHour.hour) fill.classList.add("peak");
    col.append(fill);
    col.title = `${hourLabel(h)} UTC: ${formatCount(n)} across all seven days`;
    totals.append(col);
  }
  frame.append(totals);

  const axis = node("div", "pc-axis");
  axis.setAttribute("aria-hidden", "true");
  axis.append(node("div", "pc-day"));
  for (const h of HOUR_TICKS) {
    const tick = node("div", "pc-tick", String(h).padStart(2, "0"));
    // Column 1 is the weekday gutter, so hour h is column h + 2.
    tick.style.gridColumn = String(h + 2);
    axis.append(tick);
  }
  frame.append(axis);

  const scale = node("div", "pc-scale");
  scale.append(node("span", null, "fewer"));
  const ramp = node("div", "pc-ramp");
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const cell = node("div", "pc-cell");
    const dot = node("span", "pc-dot");
    const side = (24 + frac * 76).toFixed(1);
    dot.style.width = `${side}%`;
    dot.style.height = `${side}%`;
    dot.style.opacity = (0.22 + frac * 0.78).toFixed(3);
    if (frac === 0) dot.classList.add("empty");
    cell.append(dot);
    cell.title = `about ${formatCount(Math.round(frac * frac * a.max))} repositories`;
    ramp.append(cell);
  }
  scale.append(ramp);
  scale.append(node("span", null, `more, up to ${formatCount(a.max)}`));
  frame.append(scale);

  host.append(frame);

  const finding = node("p", "chart-caption");
  finding.append(document.createTextNode("Repository creation follows a daily and weekly rhythm. "));
  finding.append(node("strong", null,
    `${quietest} is the quietest hour of the day at ${formatCount(a.quietestHour.count)} repositories, ` +
    `climbing to ${formatCount(a.busiestHour.count)} at ${busiest}`));
  finding.append(document.createTextNode(
    `, a ${swing}x swing, with the whole afternoon and evening elevated. The busiest single square is ` +
    `${peakWhen} at ${formatCount(a.peakCell.count)}. An average weekday adds ${weekdayMean} repositories ` +
    `and an average weekend day ${weekendMean}, with Sunday the quietest day of the week. ` +
    `${formatCount(a.emptyCells)} of the 168 squares ${a.emptyCells === 1 ? "is" : "are"} empty. ` +
    "That is a working week, which is not what an autonomous agent network sounds like."));
  host.append(finding);

  // Written from the batch list rather than from the two hours we know are there,
  // because the crawler re-derives the list on every refresh and a third seeding
  // run would otherwise be silently dropped by a sentence that says "two".
  const named = a.batches.map((b) => `${batchLabel(b[0])} (${formatCount(b[1])} repositories)`).join(" and ");
  const excluded = node("p", "fine");
  excluded.textContent = a.batches.length === 0
    ? "No clock-hour in this crawl reached the batch threshold, so every repository is in the grid."
    : `${formatCount(a.batches.length)} clock-hours are left out of the grid: ${named}. That is ` +
    `${formatCount(a.excluded)} repositories ` +
    `removed and ${formatCount(a.counted)} counted. They are seeding runs rather than work: the third ` +
    "busiest clock-hour in five months holds 30 repositories, so nothing organic comes near the cut of " +
    `60. Leaving them in would put ${formatCount(Math.max(...a.batches.map((b) => b[1])))} in one square ` +
    "against a median square of 11, and every other square would render as empty.";
  host.append(excluded);

  const zone = node("p", "fine");
  zone.textContent =
    "The clock is UTC, because UTC is what the node records. The swing says activity concentrates in " +
    `some band of the world's clock and nothing more. ${busiest} is late morning in New York, ` +
    "mid-afternoon in London and late evening in Tokyo, and this snapshot cannot tell those apart. " +
    "Where the operators are is not in the data.";
  host.append(zone);

  $("punchcard-alt").textContent =
    `Text alternative. Across ${formatCount(a.counted)} repository creations placed by UTC weekday and ` +
    `hour, the hourly totals run from ${formatCount(a.quietestHour.count)} at ${quietest} up to ` +
    `${formatCount(a.busiestHour.count)} at ${busiest}, a ${swing}x swing, and weekdays average ` +
    `${weekdayMean} creations against ${weekendMean} on a weekend day. The busiest square is ${peakWhen} ` +
    `at ${formatCount(a.peakCell.count)} and ${formatCount(a.emptyCells)} of the 168 squares ` +
    `${a.emptyCells === 1 ? "is" : "are"} empty.`;
}

// --- owner lifetime ------------------------------------------------------

// Two groups of proportional rows over one derivation. The bars carry different
// quantities on purpose: the span rows are a share of all owners, so the reader
// can see how lopsided the distribution is, while the size rows are a return
// rate, which is already a 0-to-1 number and would be flattened into nothing if
// it were drawn against the group sizes instead.
function renderLifetime(s) {
  const m = ownerLifetimeSummary(s);
  const pct = (x) => `${Math.round(x * 100)}%`;

  const spans = $("lifetime-spans");
  for (const b of m.spanBuckets) {
    const share = (b.share * 100).toFixed(1);
    const who = b.owners === 1 ? "owner" : "owners";
    const row = barRow(b.label, `${formatCount(b.owners)} ${who}, ${share}%`, b.fraction);
    // Marks the rows whose bar must stay at zero width. Everything else gets a
    // minimum width in CSS, because four of these five buckets are under two
    // percent and would otherwise render as nothing at all.
    if (b.owners === 0) row.classList.add("empty-row");
    spans.append(row);
  }

  const split = $("lifetime-split");
  split.append(node("strong", null,
    `${formatCount(m.oneDay)} of the ${formatCount(m.total)} owners, ` +
    `${(m.oneDayShare * 100).toFixed(1)}%, created every repository they own on a single day`));
  split.append(document.createTextNode(
    `. ${formatCount(m.returning)} ever came back on a later day, and ${formatCount(m.single)} owners ` +
    `hold exactly one repository at all. The median gap between an owner's first repository and their ` +
    `last is ${formatCount(m.medianSpan)} days, the ninetieth percentile is ${formatCount(m.p90Span)}, ` +
    `and the widest anyone reaches is ${formatCount(m.maxSpan)}. This is a network of visitors rather ` +
    "than a working population. Nine owners in ten turn up once, create something and are never seen " +
    "again, which is the same network that produced 219 separate my-first-repo repositories."));

  const seedNames = m.seedingDays.map((d) => dayLabel(s.day_base, d)).join(" and ");
  const allRates = m.bySize.map((b) => pct(b.rate)).join(", ");
  // Whether the all-repos table dips is a property of the current crawl, not a
  // fact, so it is read off the numbers rather than asserted. A sentence that
  // hardcoded "dips in the middle" would keep saying so after a crawl where it
  // no longer did, which is exactly how the families section came to claim
  // something the data had stopped supporting.
  const allRising = m.bySize.every((b, i) => i === 0 || b.rate >= m.bySize[i - 1].rate);
  const extra = m.bySize[2].owners - m.bySizeOffSeed[2].owners;
  $("lifetime-size-note").textContent =
    "Owners grouped by how many repositories they hold, and the share of each group that ever came " +
    "back. The rate climbs with size, but only once the seeding days are out of the grouping. Counted " +
    `over every repository the same four groups run ${allRates}, ` +
    (allRising
      ? "which happens to climb as well on this crawl. "
      : "which dips in the middle rather than climbing. ") +
    `The seeding days on their own put ${formatCount(extra)} extra owners into the 4 to 10 group, ` +
    "and the bars below leave those days out.";

  const sizes = $("lifetime-sizes");
  for (const b of m.bySizeOffSeed) {
    const row = barRow(b.label,
      `${formatCount(b.owners)} owners, ${formatCount(b.returned)} came back, ${pct(b.rate)}`,
      b.rate, true);
    if (b.returned === 0) row.classList.add("empty-row");
    sizes.append(row);
  }

  $("lifetime-limits").textContent =
    "Three limits worth stating. The snapshot records UTC calendar days rather than timestamps, so an " +
    "owner working across midnight reads as two days and an owner working twice in one afternoon reads " +
    `as one. The grouping above leaves out ${seedNames}, the seeding runs the punchcard already drops, ` +
    `and ${formatCount(m.seedingOnlyOwners)} owners exist only because of them; the headline holds ` +
    `either way, ${(m.oneDayShare * 100).toFixed(1)}% one-day counting every repository and ` +
    `${(m.offSeedOneDayShare * 100).toFixed(1)}% with those days removed. And never seen again means ` +
    "never created another repository. It does not mean they stopped pushing to the one they have: the " +
    "snapshot carries a last-updated day per repository that would speak to that, and this section " +
    "does not use it.";
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
    renderTagline(snapshot);
    renderCounters(snapshot);
    renderGrowth(snapshot);
    renderOwners(snapshot);
    renderFamilies(snapshot);
    renderPunchcard(snapshot);
    renderLifetime(snapshot);
    renderCapabilities(snapshot);
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
