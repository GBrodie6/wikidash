/**
 * Server-side Wikipedia lookups. The room uses these to resolve the host's page
 * picks and to verify every click, so a player can't skip links by sending a
 * forged move.
 */

const API = "https://en.wikipedia.org/w/api.php";
const UA = "WikiDash/1.0 (https://wikidash4.higgsfield.app; multiplayer Wikipedia race game)";

export type Lookup = { ok: true; title: string } | { ok: false; error: string };
export interface LinkCheck {
  ok: boolean;
  canon: string;
  reason: string;
}

interface WikiPage {
  title?: string;
  ns?: number;
  missing?: boolean;
  invalid?: boolean;
  length?: number;
  pageprops?: Record<string, unknown>;
  links?: { ns: number; title: string }[];
  pageviews?: Record<string, number | null>;
}

function views(p: WikiPage): number {
  return Object.values(p.pageviews ?? {}).reduce<number>((a, v) => a + (v ?? 0), 0);
}

async function api(params: Record<string, string>): Promise<any> {
  const url = new URL(API);
  const all: Record<string, string> = { format: "json", formatversion: "2", ...params };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": UA, "Api-User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  return res.json();
}

/** Same normalisation MediaWiki applies to a title. */
export function normTitle(raw: string): string {
  let t = String(raw ?? "");
  try {
    t = decodeURIComponent(t);
  } catch {
    /* already decoded */
  }
  t = (t.split("#")[0] ?? "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const first = t.codePointAt(0) ?? 0;
  const head = String.fromCodePoint(first);
  return head.toUpperCase() + t.slice(head.length);
}

function firstPage(json: any): WikiPage | undefined {
  const pages = json?.query?.pages;
  return Array.isArray(pages) ? (pages[0] as WikiPage | undefined) : undefined;
}

export async function resolveArticle(raw: string): Promise<Lookup> {
  const t = normTitle(raw);
  if (!t || t.length > 255) return { ok: false, error: "Type an article name." };
  try {
    const page = firstPage(await api({ action: "query", titles: t, redirects: "1" }));
    if (!page || page.missing || page.invalid || !page.title) {
      return { ok: false, error: `No Wikipedia article called "${t}".` };
    }
    if (page.ns !== 0) return { ok: false, error: `"${page.title}" isn't an article.` };
    return { ok: true, title: page.title };
  } catch {
    return { ok: false, error: "Couldn't reach Wikipedia. Try again." };
  }
}

/** A random article, preferring longer, non-list, non-disambiguation pages. */
export async function randomArticle(): Promise<Lookup> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const json = await api({
        action: "query",
        generator: "random",
        grnnamespace: "0",
        grnlimit: "50",
        prop: "info|pageprops|pageviews",
        ppprop: "disambiguation",
        pvipdays: "30",
      });
      const pages: WikiPage[] = (json?.query?.pages ?? []).filter(
        (p: WikiPage) =>
          p.title && !p.pageprops?.["disambiguation"] && !/^(List|Lists|Index|Outline|Timeline) of |\b(19|20)\d\d\b|results|season|discography|filmography|election|\(disambiguation\)/i.test(p.title),
      );
      // Favour pages people actually read, so routes start somewhere recognisable.
      pages.sort((a, b) => views(b) - views(a));
      const best = pages.find((p) => (p.length ?? 0) > 3000);
      if (best?.title) return { ok: true, title: best.title };
      if (attempt === 2 && pages[0]?.title) return { ok: true, title: pages[0].title };
    }
    return { ok: false, error: "Couldn't pick a random page. Try again." };
  } catch {
    return { ok: false, error: "Couldn't reach Wikipedia. Try again." };
  }
}

/** Does `from` link to `rawTo`? Returns the canonical article the link lands on. */
export async function verifyLink(from: string, rawTo: string): Promise<LinkCheck> {
  const to = normTitle(rawTo);
  if (!to || to.length > 255) return { ok: false, canon: "", reason: "That isn't a link." };
  try {
    const [links, target] = await Promise.all([
      api({ action: "query", titles: from, prop: "links", pltitles: to, pllimit: "10" }),
      api({ action: "query", titles: to, redirects: "1" }),
    ]);
    const landed = firstPage(target);
    if (!landed || landed.missing || landed.invalid || !landed.title) {
      return { ok: false, canon: "", reason: "That link goes to a page that doesn't exist." };
    }
    if (landed.ns !== 0) return { ok: false, canon: "", reason: "Only article links count." };

    let linked = (firstPage(links)?.links ?? []).length > 0;
    if (!linked) {
      // The link tables can lag a fresh edit; fall back to the live render.
      const parsed = await api({ action: "parse", page: from, prop: "links" });
      const all: { ns: number; title: string }[] = parsed?.parse?.links ?? [];
      const want = to.toLowerCase();
      linked = all.some((l) => l.ns === 0 && normTitle(l.title).toLowerCase() === want);
    }
    if (!linked) return { ok: false, canon: "", reason: "That link isn't on your current page." };
    return { ok: true, canon: landed.title, reason: "" };
  } catch {
    return { ok: false, canon: "", reason: "Couldn't reach Wikipedia to check that link. Try again." };
  }
}

// ── route generation ─────────────────────────────────────────────────────

export type Level = "easy" | "medium" | "hard";
export type RouteResult =
  | { ok: true; start: string; target: string; hops: number }
  | { ok: false; error: string };

const HOPS: Record<Level, [number, number]> = { easy: [2, 3], medium: [4, 5], hard: [6, 7] };

/** Same namespace list the client uses to decide what counts as an article link. */
const NS = new Set([
  "file", "image", "media", "category", "help", "special", "wikipedia", "wp", "project",
  "template", "portal", "talk", "user", "draft", "mediawiki", "module", "timedtext", "book",
  "gadget", "gadget definition", "topic", "education program", "event", "cat", "h", "t", "mos",
]);

/** Pages nearly every article links to. They make every route trivial. */
const HUBS = new Set([
  "united states", "united kingdom", "europe", "asia", "africa", "north america", "south america",
  "oceania", "antarctica", "australia", "canada", "france", "germany", "china", "india", "russia",
  "japan", "italy", "spain", "brazil", "mexico", "world war i", "world war ii", "english language",
  "latin", "greek language", "french language", "wayback machine", "wikidata", "census",
  "geographic coordinate system", "time zone", "coordinated universal time", "digital object identifier",
  "demonym", "population", "catholic church", "christianity", "islam", "latin script", "romanization",
]);

const BAD_RE =
  /^(List|Lists|Index|Outline|Glossary|Timeline) of |\((disambiguation|identifier)\)|^ISO \d|^\d|^(January|February|March|April|May|June|July|August|September|October|November|December) \d/i;

const EXCLUDED =
  ".navbox a, .vertical-navbox a, .sidebar a, .authority-control a, .portalbox a, .ambox a, .ombox a, .mw-editsection a, .toc a, #toc a";

function hrefTitle(href: string): string | null {
  const m = href.match(/^\/wiki\/([^?]+)$/);
  if (!m) return null;
  const t = normTitle((m[1] ?? "").split("#")[0] ?? "");
  if (!t) return null;
  const colon = t.indexOf(":");
  if (colon > 0) {
    const ns = t.slice(0, colon).toLowerCase();
    if (NS.has(ns) || ns.endsWith(" talk")) return null;
  }
  return t;
}

/** Not for a family game: anything explicit or grim never ends up as a stop on a generated route. */
const SENSITIVE_RE =
  /\b(sex\w*|penis|glans|vagin\w*|vulva|clitor\w*|anus|anal sex|genital\w*|porn\w*|erotic\w*|nud(e|ity)|naked|rape\w*|incest|masturbat\w*|orgasm\w*|prostitut\w*|fetish\w*|bdsm|condom\w*|abortion\w*|suicide|genocide|holocaust|massacre|nazi\w*|terroris\w*|murder\w*|cocaine|heroin|methamphetamine)\b/i;

function isBad(title: string, banned: Set<string>): boolean {
  const k = title.toLowerCase();
  return HUBS.has(k) || banned.has(k) || BAD_RE.test(title) || SENSITIVE_RE.test(title);
}

/** Article links in the body of a page: what a player can actually click, minus navboxes. */
async function bodyLinks(title: string): Promise<{ canon: string; links: string[] }> {
  const json = await api({
    action: "parse",
    page: title,
    prop: "text",
    redirects: "1",
    disableeditsection: "1",
    disabletoc: "1",
    disablelimitreport: "1",
  });
  const html: string | undefined = json?.parse?.text;
  const canon: string | undefined = json?.parse?.title;
  if (!html || !canon) throw new Error("parse failed");
  const all: string[] = [];
  const skip = new Set<string>();
  await new HTMLRewriter()
    .on('a[href^="/wiki/"]', {
      element(el) {
        const h = el.getAttribute("href");
        if (h) all.push(h);
      },
    })
    .on(EXCLUDED, {
      element(el) {
        const h = el.getAttribute("href");
        if (h) skip.add(h);
      },
    })
    .transform(new Response(html))
    .text();
  const seen = new Set<string>();
  const links: string[] = [];
  for (const h of all) {
    if (skip.has(h)) continue;
    const t = hrefTitle(h);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    links.push(t);
  }
  return { canon, links };
}

/** Of a handful of candidate links, the one with the most recent readers (so the target is recognisable). */
async function mostRead(cand: string[], fallback: string): Promise<{ title: string; views: number }> {
  try {
    const sample = [...cand].sort(() => Math.random() - 0.5).slice(0, 14);
    const json = await api({ action: "query", titles: sample.join("|"), prop: "pageviews", pvipdays: "30", redirects: "1" });
    const pages: WikiPage[] = json?.query?.pages ?? [];
    const best = pages.filter((p) => p.title && p.ns === 0 && !p.missing).sort((a, b) => views(b) - views(a))[0];
    if (best?.title && views(best) > 0) return { title: best.title, views: views(best) };
  } catch {
    /* fall through */
  }
  return { title: fallback, views: 0 };
}

/** Daily routes start from something everyone has heard of. */
const STARTS = [
  "Pizza", "Chocolate", "Coffee", "Tea", "Bread", "Cheese", "Sushi", "Banana", "Apple", "Hamburger", "Ice cream",
  "Pasta", "Potato", "Rice", "Wine", "Beer", "Honey", "Egg", "Salt", "Sugar", "Dog", "Cat", "Horse", "Elephant",
  "Shark", "Eagle", "Dolphin", "Tiger", "Penguin", "Octopus", "Whale", "Butterfly", "Spider", "Snake", "Wolf", "Bear",
  "Owl", "Frog", "Giraffe", "Kangaroo", "Volcano", "Rainforest", "Mount Everest", "Amazon River", "Sahara",
  "Great Barrier Reef", "Hurricane", "Tornado", "Rainbow", "Glacier", "Earthquake", "Desert", "Ocean", "Lightning",
  "Moon", "Mars", "Black hole", "DNA", "Atom", "Electricity", "Internet", "Computer", "Robot", "Telescope",
  "Dinosaur", "Photosynthesis", "Gravity", "Periodic table", "Satellite", "Airplane", "Submarine", "Bicycle",
  "Light bulb", "Camera", "Albert Einstein", "Leonardo da Vinci", "William Shakespeare", "Isaac Newton",
  "Marie Curie", "Napoleon", "Cleopatra", "Abraham Lincoln", "Nikola Tesla", "Charles Darwin",
  "Wolfgang Amadeus Mozart", "Ludwig van Beethoven", "Pablo Picasso", "Vincent van Gogh", "Walt Disney",
  "Elvis Presley", "The Beatles", "Muhammad Ali", "Michael Jordan", "Mahatma Gandhi", "Paris", "London", "Tokyo",
  "New York City", "Rome", "Egypt", "Great Wall of China", "Eiffel Tower", "Statue of Liberty", "Grand Canyon",
  "Niagara Falls", "Venice", "Hawaii", "Iceland", "Greece", "Kenya", "Peru", "Norway", "Thailand", "Cuba", "Football",
  "Basketball", "Baseball", "Chess", "Olympic Games", "Piano", "Guitar", "Jazz", "Opera", "Cinema", "Television",
  "Video game", "Harry Potter", "Star Wars", "Superman", "Pokémon", "Minecraft", "Lego", "Roman Empire",
  "Ancient Egypt", "Renaissance", "Industrial Revolution", "Cold War", "French Revolution", "Samurai", "Pirate",
  "Knight", "Castle", "RMS Titanic", "Apollo 11", "Mathematics", "Music", "Painting",
];

/** Daily routes: never longer than 5 clicks, and the target has to be something people know. */
const DAILY_HOPS: Record<Level, [number, number]> = { easy: [2, 2], medium: [3, 4], hard: [5, 5] };
const MIN_TARGET_VIEWS = 40000;

/** Mon, Wed, Sun easy. Tue, Fri medium. Thu, Sat hard. Same for everyone, so people know what kind of day it is. */
export function dailyLevel(date: string): Level {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  const week: Level[] = ["easy", "easy", "medium", "easy", "hard", "medium", "hard"];
  return week[dow] ?? "medium";
}

/**
 * A start and target that are reachable by construction: pick a start, then
 * follow real in-article links for a few hops. The target is where the walk
 * ends, so a route of N hops is always doable in N clicks or fewer.
 */
export async function randomRoute(level: Level, banned: string[] = [], opts: { daily?: boolean } = {}): Promise<RouteResult> {
  const daily = Boolean(opts.daily);
  const range = (daily ? DAILY_HOPS : HOPS)[level] ?? HOPS.medium;
  const ban = new Set(banned.map((b) => b.toLowerCase()));
  const attempts = daily ? 8 : 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const hops = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
    try {
      let cur: string;
      if (daily) cur = STARTS[Math.floor(Math.random() * STARTS.length)] as string;
      else {
        const first = await randomArticle();
        if (!first.ok || isBad(first.title, ban)) continue;
        cur = first.title;
      }
      const seen = new Set<string>();
      let start = cur;
      let startLinks = new Set<string>();
      let target = "";
      let good = true;
      for (let i = 0; i < hops; i++) {
        const { canon, links } = await bodyLinks(cur);
        if (seen.has(canon.toLowerCase())) {
          good = false;
          break;
        }
        seen.add(canon.toLowerCase());
        if (i === 0) {
          start = canon;
          startLinks = new Set(links.map((l) => l.toLowerCase()));
        }
        const cand = links.filter((l) => !seen.has(l.toLowerCase()) && !isBad(l, ban));
        if (cand.length < 3) {
          good = false;
          break;
        }
        const pick = cand[Math.floor(Math.random() * cand.length)] as string;
        if (i === hops - 1) {
          const best = await mostRead(cand, pick);
          // Early daily attempts insist on a well-known target; the last two take whatever works.
          if (daily && attempt < attempts - 2 && best.views < MIN_TARGET_VIEWS) {
            good = false;
            break;
          }
          const r = await resolveArticle(best.title);
          if (!r.ok || isBad(r.title, ban) || seen.has(r.title.toLowerCase())) good = false;
          else target = r.title;
        } else {
          cur = pick;
        }
      }
      if (!good || !target) continue;
      if (hops >= 3 && startLinks.has(target.toLowerCase())) continue;
      return { ok: true, start, target, hops };
    } catch {
      /* try again with a fresh start */
    }
  }
  return { ok: false, error: "Couldn't build a route right now. Try again." };
}

/** Today's date in US Eastern time, YYYY-MM-DD. The daily challenge rolls over at midnight there. */
export function etDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
