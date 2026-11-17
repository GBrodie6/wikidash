// The daily challenge: one shared route per day, scored by fewest clicks.

import { h, icon, fmtTime } from "./ui.js";
import { playerId } from "./net.js";

export async function fetchDaily() {
  const r = await fetch(`/api/daily?pid=${encodeURIComponent(playerId())}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "The daily challenge isn't available right now.");
  return j;
}

export function dateLabel(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function boardList(top, limit = 5) {
  const rows = top.slice(0, limit).map((e) =>
    h(
      "li",
      { class: `lb-row${e.you ? " you" : ""}` },
      h("span", { class: "lb-rank" }, String(e.rank)),
      h("span", { class: "lb-name" }, e.name, e.you ? h("span", { class: "tag" }, "you") : null, e.leaves ? h("span", { class: "flag-pill", title: `Left the tab ${e.leaves}x` }, icon("door", 12), `${e.leaves}x`) : null),
      h("span", { class: "lb-clicks" }, `${e.clicks} click${e.clicks === 1 ? "" : "s"}`),
      h("span", { class: "lb-time" }, fmtTime(e.ms)),
    ),
  );
  return h("ol", { class: "lb-list" }, rows.length ? rows : h("li", { class: "lb-empty" }, "No finishes yet today. Be the first."));
}

const LEVEL_TEXT = { easy: "Easy day", medium: "Medium day", hard: "Hard day" };

/** A small tag saying how hard today's route is. */
export function levelPill(level) {
  if (!LEVEL_TEXT[level]) return null;
  return h("span", { class: `lvl lvl-${level}` }, LEVEL_TEXT[level]);
}
