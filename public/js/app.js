import { h, clear, toast, icon } from "./ui.js";
import * as net from "./net.js";
import * as guard from "./guard.js";
import { brand, toolButtons } from "./shell.js";
import { initTheme } from "./theme.js";
import { mountReactions, showSay } from "./react.js";
import { fetchDaily, dateLabel, boardList, levelPill } from "./daily.js";
import { mountLobby, updateLobby, lobbyError } from "./lobby.js";
import { mountRace, updateRace, raceError, unmountRace, raceBack } from "./race.js";

initTheme();

const app = document.getElementById("app");
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
const cleanName = (n) => String(n || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
const params = new URLSearchParams(location.search);

const S = {
  code: cleanCode(params.get("room")),
  name: cleanName(localStorage.getItem("wd:name")),
  view: null,
  connected: [],
  offset: 0,
  conn: "connecting",
  screen: null,
  started: false,
};

const ctx = {
  S,
  act: net.act,
  now: () => Date.now() + S.offset,
  /** The host or a co-host: can run the party. */
  isHost: () => Boolean(S.view && S.view.joined && (S.view.host === S.view.you || (S.view.cohosts || []).includes(S.view.you))),
  /** The host only: can hand over the host role and choose co-hosts. */
  isOwner: () => Boolean(S.view && S.view.joined && S.view.host === S.view.you),
  online: (pid) => S.connected.includes(pid),
  setName(n) {
    S.name = cleanName(n);
    localStorage.setItem("wd:name", S.name);
    net.act({ kind: "hello", name: S.name });
  },
};

guard.setHooks({
  onLeave: () => net.act({ kind: "left", phase: "start" }),
  onReturn: (ms) => net.act({ kind: "left", phase: "end", ms }),
  onBack: () => raceBack(ctx),
  notify: (m) => toast(m, "warn"),
});

function randomCode(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

// ── landing ──────────────────────────────────────────────────────────────

function landing() {
  S.screen = "landing";
  clear(app);
  document.body.classList.add("ruled");
  const invited = Boolean(S.code);
  const nameIn = h("input", {
    class: "field", id: "name", maxlength: 20, autocomplete: "nickname",
    placeholder: "Your name", value: S.name,
  });
  const codeIn = h("input", {
    class: "field code", maxlength: 12, placeholder: "CODE", autocapitalize: "characters", spellcheck: "false",
    oninput: (e) => (e.target.value = cleanCode(e.target.value)),
  });

  const needName = () => {
    const n = cleanName(nameIn.value);
    if (!n) {
      nameIn.focus();
      nameIn.classList.add("shake");
      setTimeout(() => nameIn.classList.remove("shake"), 400);
      toast("Pick a name first.", "warn");
      return null;
    }
    return n;
  };
  const go = (code) => {
    const n = needName();
    if (n === null) return;
    S.name = n;
    localStorage.setItem("wd:name", n);
    S.code = code;
    history.replaceState(null, "", `/?room=${code}`);
    start();
  };

  let form;
  if (invited) {
    form = h(
      "div",
      { class: "join-card card" },
      h("p", { class: "eyebrow" }, "You're invited to party"),
      h("div", { class: "big-code" }, S.code),
      h("label", { class: "lbl", for: "name" }, "Your name"),
      nameIn,
      h("button", { class: "btn primary xl", type: "button", onclick: () => go(S.code) }, "Join the party", icon("arrow")),
      h("a", { class: "subtle-link", href: "/" }, "Or start your own party"),
    );
  } else {
    form = h(
      "div",
      { class: "join-card card" },
      h("label", { class: "lbl", for: "name" }, "Your name"),
      nameIn,
      h("button", { class: "btn primary xl", type: "button", onclick: () => go(randomCode(5)) }, "Create a party", icon("arrow")),
      h("div", { class: "or" }, h("span", null, "or join one")),
      h(
        "div",
        { class: "join-row" },
        codeIn,
        h(
          "button",
          {
            class: "btn", type: "button",
            onclick: () => {
              const c = cleanCode(codeIn.value);
              if (c.length < 4) {
                toast("Enter the party code from your host.", "warn");
                codeIn.focus();
                return;
              }
              go(c);
            },
          },
          "Join",
        ),
      ),
    );
  }

  app.append(
    h(
      "main",
      { class: "landing" },
      h(
        "section",
        { class: "hero" },
        h("div", { class: "hero-top" }, brand(), toolButtons()),
        h("h1", { class: "display" }, "Race your friends across ", h("em", null, "Wikipedia.")),
        h("p", { class: "lead" }, "Everyone starts on the same article. Click only the links on the page. First one to reach the target wins."),
        routeArt(),
        h(
          "ol",
          { class: "features" },
          [["Online party rooms.", "Share a link. Up to 24 players."], ["Every click is verified.", "No skipping pages."], ["The host sets the rules.", "Race, fewest clicks, teams or elimination."]].map(([b, t], i) =>
            h("li", null, h("span", { class: "fx-n" }, String(i + 1).padStart(2, "0")), h("span", null, h("b", null, b), " ", t)),
          ),
        ),
      ),
      h("section", { class: "entry" }, form, invited ? null : publicCard(go), invited ? null : dailyCard(go, nameIn)),
    ),
  );
  setTimeout(() => nameIn.focus(), 50);
  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") invited ? go(S.code) : go(randomCode(5));
  });
  codeIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.nextSibling.click();
  });
}

const MODE_LABEL = { race: "Race", fewest: "Fewest clicks", teams: "Teams", elim: "Elimination" };

/** Parties whose host made them public. Anyone can join one with the name typed above. */
function publicCard(go) {
  const list = h("div", { class: "pub-list" }, h("div", { class: "spinner sm" }));
  const card = h("section", { class: "card pub-card" }, h("div", { class: "daily-head" }, icon("users", 16), h("h2", { class: "card-title" }, "Public parties")), list);
  const load = () =>
    fetch("/api/public", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const rows = (d.parties || []).map((p) =>
          h(
            "div",
            { class: "pub-row" },
            h("div", { class: "pub-main" }, h("b", null, `${p.host}'s party`), h("span", { class: "muted sm" }, `${p.players} of ${p.max} · ${MODE_LABEL[p.mode] || p.mode}${p.mode !== "elim" && p.rounds > 1 ? ` · ${p.rounds} rounds` : ""}`)),
            h("button", { class: "btn sm primary", type: "button", disabled: p.players >= p.max, onclick: () => go(p.room) }, p.players >= p.max ? "Full" : "Join"),
          ),
        );
        clear(list).append(...(rows.length ? rows : [h("p", { class: "muted sm" }, "No public parties right now. Start a party and set it to public in the lobby.")]));
      })
      .catch(() => clear(list).append(h("p", { class: "muted sm" }, "Couldn't load public parties.")));
  load();
  const timer = setInterval(() => (card.isConnected ? load() : clearInterval(timer)), 8000);
  return card;
}

const SVG = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  if (text) el.textContent = text;
  return el;
}

/** A route drawing itself across the page: the whole game in one picture. */
function routeArt() {
  const stops = ["Banana", "Ecuador", "Andes", "Astronomy", "Moon"];
  const xs = [44, 166, 288, 410, 532];
  const ys = [74, 38, 74, 38, 74];
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 1; i < xs.length; i++) {
    const cx = (xs[i - 1] + xs[i]) / 2;
    d += ` C${cx},${ys[i - 1]} ${cx},${ys[i]} ${xs[i]},${ys[i]}`;
  }
  const svg = svgEl("svg", { class: "route-art", viewBox: "0 0 576 118", role: "img", "aria-label": "A route from Banana to Moon through Ecuador, Andes and Astronomy" });
  svg.append(svgEl("path", { class: "ra-line", d, pathLength: 1 }));
  stops.forEach((name, i) => {
    const end = i === stops.length - 1;
    const low = ys[i] > 60;
    svg.append(svgEl("circle", { class: `ra-node${end ? " end" : ""}`, cx: xs[i], cy: ys[i], r: end ? 9 : 6, style: `--i:${i}` }));
    const label = svgEl("text", { class: end ? "end" : "", x: xs[i], y: low ? ys[i] + 28 : ys[i] - 18, style: `--i:${i}` }, name);
    svg.append(label);
  });
  const dot = svgEl("circle", { class: "ra-dot", r: 4 });
  const move = svgEl("animateMotion", { dur: "5s", begin: "3.4s", repeatCount: "indefinite", path: d, calcMode: "spline", keySplines: "0.5 0 0.5 1", keyTimes: "0;1" });
  dot.append(move);
  svg.append(dot);
  return svg;
}

function dailyCard(go, mainName) {
  const body = h("div", { class: "daily-body" }, h("div", { class: "spinner sm" }));
  const dn = h("input", { class: "field", maxlength: 20, autocomplete: "nickname", placeholder: "Your name for the leaderboard", "aria-label": "Your name for the leaderboard", value: mainName.value });
  const play = h(
    "button",
    {
      class: "btn xl", type: "button", disabled: true,
      onclick: () => {
        const n = cleanName(dn.value);
        if (!n) {
          dn.focus();
          dn.classList.add("shake");
          setTimeout(() => dn.classList.remove("shake"), 400);
          toast("Type a name for the leaderboard.", "warn");
          return;
        }
        mainName.value = n;
        go("DAILY" + randomCode(6));
      },
    },
    "Play today's challenge",
    icon("arrow"),
  );
  dn.addEventListener("keydown", (e) => e.key === "Enter" && play.click());
  dn.addEventListener("focus", () => {
    if (!dn.value) dn.value = mainName.value;
  });
  const card = h(
    "section",
    { class: "card daily-card" },
    h("div", { class: "daily-head" }, icon("calendar", 16), h("h2", { class: "card-title" }, "Daily challenge"), h("span", { class: "daily-date" })),
    body,
    h("div", { class: "daily-play" }, dn, play),
    h("p", { class: "muted sm" }, "A new route every day at midnight Eastern."),
  );
  const load = () =>
    fetchDaily()
      .then((d) => {
        card.querySelector(".daily-date").textContent = dateLabel(d.date);
        const pill = levelPill(d.level);
        if (pill) card.querySelector(".daily-head .lvl")?.remove();
        if (pill) card.querySelector(".daily-head").insertBefore(pill, card.querySelector(".daily-date"));
        clear(body).append(
          h("div", { class: "daily-route" }, h("span", { class: "rchip start" }, d.start), icon("arrow", 16), h("span", { class: "rchip target" }, icon("flag", 14), d.target)),
          h("p", { class: "muted sm" }, `Doable in ${d.hops} click${d.hops === 1 ? "" : "s"} or fewer. Fewest clicks wins. ${d.total} ${d.total === 1 ? "finish" : "finishes"} today.`),
          boardList(d.top, 3),
        );
        clear(play).append(d.you ? "Try again" : "Play today's challenge", icon("arrow"));
        play.disabled = false;
      })
      .catch((err) => {
        clear(body).append(h("p", { class: "muted sm" }, err.message || "The daily challenge isn't available right now."), h("button", { class: "btn sm", type: "button", onclick: () => (clear(body).append(h("div", { class: "spinner sm" })), load()) }, "Try again"));
      });
  load();
  return card;
}

// ── game screens ─────────────────────────────────────────────────────────

function start() {
  document.body.classList.remove("ruled");
  S.started = true;
  S.screen = "connecting";
  clear(app);
  app.append(h("div", { class: "center-msg" }, h("div", { class: "spinner" }), h("p", null, "Joining party ", h("b", null, S.code), "...")));
  net.connect(
    S.code,
    () => S.name,
    {
      onState(msg) {
        S.view = msg.view;
        S.connected = msg.connected || [];
        S.offset = msg.serverNow - Date.now();
        mountReactions(net.act);
        route();
      },
      onError(err) {
        toast(err, "error");
        if (S.screen === "race") raceError(ctx, err);
        if (S.screen === "lobby") lobbyError(ctx, err);
      },
      onConn(status) {
        S.conn = status;
        document.documentElement.dataset.conn = status;
      },
      onSay: showSay,
    },
  );
}

function show(screen, mount) {
  if (S.screen === screen) return;
  if (S.screen === "race") unmountRace();
  S.screen = screen;
  clear(app);
  mount?.(app, ctx);
}

function route() {
  const v = S.view;
  if (!v) return;
  if (v.kicked) {
    show("kicked", (root) =>
      root.append(h("div", { class: "center-msg" }, h("h2", { class: "display" }, "You were removed from this party."), h("a", { class: "btn primary", href: "/" }, "Start your own party"))),
    );
    guard.configure({ active: false });
    return;
  }
  if (!v.joined) {
    show("joining", (root) => root.append(h("div", { class: "center-msg" }, h("div", { class: "spinner" }), h("p", null, "Joining..."))));
    return;
  }
  // A daily attempt is set up by the server right after joining. Wait for it.
  if (/^DAILY/.test(S.code) && v.phase === "lobby" && !v.settings.daily && !S.dailyGaveUp) {
    show("daily-wait", (root) => root.append(h("div", { class: "center-msg" }, h("div", { class: "spinner" }), h("p", null, "Getting today's challenge..."))));
    if (!S.dailyTimer) {
      S.dailyTimer = setTimeout(() => {
        S.dailyGaveUp = true;
        route();
      }, 15000);
    }
    return;
  }
  if (v.phase === "lobby") {
    show("lobby", mountLobby);
    updateLobby(ctx);
  } else {
    show("race", mountRace);
    updateRace(ctx);
  }
}

if (S.code && S.name) start();
else landing();
