// Client-side Wikipedia: fetch + clean articles, search, summaries.
// Every link the player can click is rewritten to a data attribute so it can
// never open real Wikipedia (no ctrl-click, middle-click or drag to a new tab).

const API = "https://en.wikipedia.org/w/api.php";
const REST = "https://en.wikipedia.org/api/rest_v1";

const NAMESPACES = new Set([
  "file", "image", "media", "category", "help", "special", "wikipedia", "wp", "project",
  "template", "portal", "talk", "user", "draft", "mediawiki", "module", "timedtext", "book",
  "gadget", "gadget definition", "topic", "education program", "event", "cat", "h", "t", "mos",
]);

/** decodeURIComponent that never throws (some hrefs carry a bare "%"). */
export function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return String(v).replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
}

export function normTitle(raw) {
  let t = safeDecode(String(raw ?? ""));
  t = t.split("#")[0].replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const head = String.fromCodePoint(t.codePointAt(0));
  return head.toUpperCase() + t.slice(head.length);
}

export const sameTitle = (a, b) => normTitle(a).toLowerCase() === normTitle(b).toLowerCase();

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Wikipedia ${r.status}`);
  return r.json();
}

const articles = new Map();
export function fetchArticle(title) {
  const k = normTitle(title).toLowerCase();
  if (articles.has(k)) return articles.get(k);
  const p = (async () => {
    const qs = new URLSearchParams({
      action: "parse", format: "json", formatversion: "2", origin: "*", page: normTitle(title),
      prop: "text|displaytitle", redirects: "1", disableeditsection: "1", disabletoc: "1",
    });
    const j = await getJSON(`${API}?${qs}`);
    if (j.error) throw new Error(j.error.info || "Couldn't load that page");
    return { title: j.parse.title, html: j.parse.text };
  })();
  articles.set(k, p);
  p.then((a) => articles.set(a.title.toLowerCase(), p)).catch(() => articles.delete(k));
  return p;
}

export async function search(q) {
  if (!q.trim()) return [];
  const qs = new URLSearchParams({
    action: "opensearch", format: "json", origin: "*", search: q, limit: "7", namespace: "0",
  });
  const j = await getJSON(`${API}?${qs}`);
  return Array.isArray(j[1]) ? j[1] : [];
}

const summaries = new Map();
export function summary(title) {
  const k = normTitle(title).toLowerCase();
  if (!summaries.has(k)) {
    const p = getJSON(`${REST}/page/summary/${encodeURIComponent(normTitle(title).replace(/ /g, "_"))}`)
      .then((j) => ({
        title: j.title,
        description: j.description || "",
        extract: j.extract || "",
        thumb: j.thumbnail?.source || "",
      }))
      .catch(() => ({ title: normTitle(title), description: "", extract: "", thumb: "" }));
    summaries.set(k, p);
  }
  return summaries.get(k);
}

/** Canonical article title (follows redirects), or null if it isn't an article. */
export async function canonical(title) {
  const qs = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", origin: "*", titles: normTitle(title), redirects: "1",
  });
  const j = await getJSON(`${API}?${qs}`);
  const p = j?.query?.pages?.[0];
  if (!p || p.missing || p.invalid || p.ns !== 0) return null;
  return p.title;
}

function linkTarget(href) {
  if (!href) return null;
  const m = href.match(/^(?:https?:)?(?:\/\/en\.wikipedia\.org)?\/wiki\/([^?]+)$/);
  if (!m) return null;
  const [path, frag = ""] = m[1].split("#");
  const title = normTitle(path);
  if (!title) return null;
  const colon = title.indexOf(":");
  if (colon > 0) {
    const ns = title.slice(0, colon).toLowerCase();
    if (NAMESPACES.has(ns) || ns.endsWith(" talk")) return null;
  }
  return { title, frag: safeDecode(frag) };
}

/** Turn raw parse HTML into a safe, game-ready node. */
export function buildArticle(html, { allowNavboxes, current }) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body.querySelector(".mw-parser-output") || doc.body;
  const kill = [
    "script", "iframe", "object", "embed", "form", "input", "button", "meta",
    "link:not([rel=stylesheet])", ".mw-editsection", ".mw-empty-elt", ".ambox", ".ombox",
    ".mw-references-wrap .mw-cite-backlink a", "#toc", ".toc",
  ];
  if (!allowNavboxes) kill.push(".navbox", ".navbox-styles", ".vertical-navbox", ".sidebar", ".authority-control", ".portalbox");
  root.querySelectorAll(kill.join(",")).forEach((n) => n.remove());
  root.querySelectorAll("[style*='position:fixed'],[style*='position: fixed']").forEach((n) => n.removeAttribute("style"));
  root.querySelectorAll("*").forEach((n) => {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
  });
  root.querySelectorAll("img").forEach((img) => {
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    for (const attr of ["src", "srcset"]) {
      const v = img.getAttribute(attr);
      if (v) img.setAttribute(attr, v.replace(/(^|\s|,)\/\//g, "$1https://"));
    }
  });
  root.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    a.removeAttribute("href");
    a.removeAttribute("title");
    a.removeAttribute("target");
    a.draggable = false;
    if (href.startsWith("#")) {
      a.dataset.frag = safeDecode(href.slice(1));
      a.className = "fl";
      return;
    }
    const tgt = a.classList.contains("new") || a.classList.contains("mw-file-description") ? null : linkTarget(href);
    if (!tgt) {
      a.className = "dead";
      return;
    }
    if (current && sameTitle(tgt.title, current)) {
      a.className = "fl";
      a.dataset.frag = tgt.frag;
      return;
    }
    a.className = "wl";
    a.dataset.to = tgt.title;
    a.setAttribute("role", "link");
    a.tabIndex = 0;
  });
  root.querySelectorAll("area").forEach((n) => n.removeAttribute("href"));
  const wrap = document.createElement("div");
  wrap.className = "mw-parser-output";
  wrap.append(...[...root.childNodes].map((n) => document.importNode(n, true)));
  return wrap;
}
