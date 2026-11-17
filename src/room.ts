/**
 * `Room` — one WikiDash party, as a Durable Object.
 *
 * This is the TRUSTED half of the game. It owns the sockets and storage, stamps
 * every action with server time, and does the Wikipedia lookups (page picks,
 * route generation, click verification) before handing the action to
 * `./logic.js` for the rules.
 *
 * Network calls happen BEFORE the state is loaded for the write. A Durable
 * Object lets other events in while a fetch is outstanding, so state is always
 * re-read after the lookup and then validated, applied and saved with only
 * storage awaits in between (input gates keep that atomic).
 *
 * The same class also backs the daily challenge. A room named `lb-<date>` is the
 * day's leaderboard (HTTP only), and a room named `DAILY...` is one solo attempt
 * whose route the server sets itself.
 *
 * Wire protocol:
 *   in:  {type:"join", playerId} | {type:"action", action}
 *   out: {type:"state", you, view, connected, serverNow, meta}
 *      | {type:"say", pid, name, id, text} | {type:"error", error}
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import * as logic from "./logic.js";
import { parseClientMessage } from "./protocol";
import { dailyLevel, etDate, randomArticle, randomRoute, resolveArticle, verifyLink, type Level, type RouteResult } from "./wiki";

type Conns = Record<string, string>;
type GameState = any;
type Route = { start: string; target: string; hops: number; level?: string };
type Entry = { pid: string; name: string; clicks: number; ms: number; leaves: number };
type Listing = { room: string; host: string; players: number; mode: string; rounds: number; at: number };

const PING = "__ping";
const PONG = "__pong";
const SYSTEM = "__system";

/** Everything a client may ask for. `_t` is never accepted from a client. */
const CLIENT_KINDS = new Set([
  "hello", "settings", "setPage", "randomPage", "randomRoute", "clearPage", "swapPages",
  "setTeam", "setCohost", "suggest", "useSuggestion", "dismissSuggestion", "start", "next", "move", "back", "pass", "left", "forfeit", "endRound", "lobby",
  "kick", "makeHost", "claimHost", "say",
]);

/** Reactions and quick chat. Players pick an id; the server owns the text. */
const SAYS: Record<string, string> = {
  e0: "👍", e1: "😂", e2: "🔥", e3: "😮", e4: "😭", e5: "👏",
  p0: "Nice one", p1: "So close", p2: "GG", p3: "Too easy", p4: "Help", p5: "Oops", p6: "Rematch?", p7: "Wow",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export class Room extends DurableObject<Env> {
  private name = "";
  private lastSay = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // ── storage ────────────────────────────────────────────────────────────

  private async loadState(): Promise<GameState> {
    const saved = await this.ctx.storage.get<GameState>("state");
    // Rooms saved by an older version of the rules start fresh.
    return saved && saved.v === 2 ? saved : logic.setup([]);
  }

  private async loadConns(): Promise<Conns> {
    return (await this.ctx.storage.get<Conns>("conns")) ?? {};
  }

  private async rememberRoom(fromHeader: string): Promise<void> {
    if (!this.name) this.name = (await this.ctx.storage.get<string>("room")) ?? "";
    if (fromHeader && fromHeader !== this.name) {
      this.name = fromHeader;
      await this.ctx.storage.put("room", fromHeader);
    }
  }

  // ── http + sockets ─────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    await this.rememberRoom(request.headers.get("x-room") ?? "");

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ connId: crypto.randomUUID().slice(0, 8) });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // The directory room lists public parties. Parties report to it; the Worker reads it.
    if (this.name === "dir") {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/list") return this.dirList();
      if (request.method === "POST" && url.pathname === "/upsert") return this.dirUpsert(await request.json().catch(() => null));
      if (request.method === "POST" && url.pathname === "/remove") return this.dirRemove(await request.json().catch(() => null));
    }

    // Leaderboard rooms answer plain HTTP, and only to other parts of the Worker.
    if (this.name.startsWith("lb-")) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/daily") return this.dailyInfo(url.searchParams.get("pid") ?? "");
      if (request.method === "POST" && url.pathname === "/submit") {
        return this.dailySubmit(await request.json().catch(() => null));
      }
    }
    return new Response("expected a websocket upgrade", { status: 426 });
  }

  private connIdOf(ws: WebSocket): string | undefined {
    const att = ws.deserializeAttachment() as { connId?: string } | null;
    return att?.connId;
  }

  private sendTo(connId: string, data: unknown): void {
    const body = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (this.connIdOf(ws) !== connId) continue;
      try {
        ws.send(body);
      } catch {
        /* closing */
      }
    }
  }

  private error(connId: string | null, error: string): void {
    if (connId) this.sendTo(connId, { type: "error", error });
  }

  private async broadcast(state?: GameState): Promise<void> {
    const game = state ?? (await this.loadState());
    const conns = await this.loadConns();
    const connected = [...new Set(Object.values(conns))];
    const serverNow = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const connId = this.connIdOf(ws);
      const pid = connId ? conns[connId] : undefined;
      if (!pid) continue;
      try {
        ws.send(
          JSON.stringify({
            type: "state",
            you: pid,
            view: logic.viewFor(game, pid),
            connected,
            serverNow,
            meta: logic.meta,
          }),
        );
      } catch {
        /* closing */
      }
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const connId = this.connIdOf(ws);
    if (!connId) return;
    try {
      await this.onMessage(connId, raw);
    } catch (err) {
      console.error("room message failed:", err instanceof Error ? err.stack : String(err));
      this.error(connId, "Something went wrong. Try again.");
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const connId = this.connIdOf(ws);
    if (!connId) return;
    const conns = await this.loadConns();
    if (conns[connId] === undefined) return;
    delete conns[connId];
    await this.ctx.storage.put("conns", conns);
    await this.broadcast();
    await this.syncDirectory(await this.loadState());
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Time limit expiry, and a once-a-minute check-in that keeps a public party on the list. */
  override async alarm(): Promise<void> {
    try {
      const state = await this.loadState();
      if (state.phase === "racing" && state.round?.endAt) {
        await this.commit(SYSTEM, { kind: "tick", _t: { now: Date.now() } }, null);
        return;
      }
      await this.syncDirectory(state, true);
      if ((await this.onlineCount(state)) > 0) await this.schedule(state);
      else await this.ctx.storage.deleteAlarm();
    } catch (err) {
      console.error("room alarm failed:", err instanceof Error ? err.stack : String(err));
    }
  }

  // ── actions ────────────────────────────────────────────────────────────

  private async onMessage(connId: string, raw: string | ArrayBuffer): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.error(connId, parsed.error);
    const msg = parsed.msg;

    if (msg.type === "join") {
      const conns = await this.loadConns();
      conns[connId] = msg.playerId;
      await this.ctx.storage.put("conns", conns);
      await this.ensureDaily();
      await this.broadcast();
      return this.syncDirectory(await this.loadState());
    }
    if (msg.type === "reset") return this.error(connId, "not supported");

    const conns = await this.loadConns();
    const pid = conns[connId];
    if (!pid) return this.error(connId, "join first");

    const a = msg.action;
    if (!isRecord(a) || typeof a.kind !== "string" || !CLIENT_KINDS.has(a.kind)) {
      return this.error(connId, "unknown action");
    }
    if (a.kind === "say") return this.handleSay(pid, a);

    const action: Record<string, unknown> = { ...a };
    delete action._t;
    const t: Record<string, unknown> = {
      now: Date.now(),
      connected: [...new Set(Object.values(conns))],
    };

    if (a.kind === "setPage" || a.kind === "randomPage") {
      const pre = await this.loadState();
      if (!(pre.host === pid || (pre.cohosts ?? []).includes(pid))) return this.error(connId, "Only the host can pick pages.");
      if (pre.phase !== "lobby") return this.error(connId, "Pages are locked during a match.");
      const found =
        a.kind === "randomPage" ? await randomArticle() : await resolveArticle(String(a.title ?? ""));
      if (!found.ok) return this.error(connId, found.error);
      action.kind = "setPage";
      delete action.title;
      t.resolved = { title: found.title };
    }

    // Anyone in the lobby can suggest a page. The lookup happens here, like a host's pick.
    if (a.kind === "suggest") {
      const pre = await this.loadState();
      if (!pre.players[pid]) return this.error(connId, "Join the party first.");
      if (pre.phase !== "lobby") return this.error(connId, "Suggestions are closed.");
      const found = await resolveArticle(String(a.title ?? ""));
      if (!found.ok) return this.error(connId, found.error);
      delete action.title;
      t.resolved = { title: found.title };
    }

    if (a.kind === "randomRoute" || (a.kind === "next" && a.route === "new")) {
      const pre = await this.loadState();
      if (!(pre.host === pid || (pre.cohosts ?? []).includes(pid))) return this.error(connId, "Only the host can do that.");
      if (pre.settings.daily) return this.error(connId, "The daily route is fixed.");
      if (a.kind === "randomRoute" && pre.phase !== "lobby") return this.error(connId, "Pages are locked during a match.");
      if (a.kind === "next" && pre.phase !== "over") return this.error(connId, "The round isn't over yet.");
      const made = await randomRoute(pre.settings.difficulty as Level, pre.settings.banned ?? []);
      if (!made.ok) return this.error(connId, made.error);
      t.route = { start: made.start, target: made.target, hops: made.hops };
      if (a.kind === "randomRoute") action.kind = "setRoute";
    }

    if (a.kind === "move") {
      const pre = await this.loadState();
      const key = pre.round?.teamOf?.[pid];
      const unit = key ? pre.round.units[key] : null;
      if (pre.phase !== "racing" || !unit || unit.status !== "running") {
        return this.error(connId, "You're not racing.");
      }
      if ((t.now as number) < pre.round.startAt) return this.error(connId, "Wait for the countdown.");
      if (pre.round.mode === "teams" && unit.turn !== pid) return this.error(connId, "It's not your turn.");
      const from: string = unit.stack[unit.stack.length - 1];
      const check = await verifyLink(from, String(a.to ?? ""));
      t.from = from;
      t.verified = check.ok;
      t.canon = check.canon;
      t.reason = check.reason;
    }

    action._t = t;
    await this.commit(pid, action, connId);
  }

  /** Reactions and quick chat: never stored, just passed to everyone in the room. */
  private async handleSay(pid: string, a: Record<string, unknown>): Promise<void> {
    const id = String(a.id ?? "");
    const text = SAYS[id];
    if (!text) return;
    const now = Date.now();
    if (now - (this.lastSay.get(pid) ?? 0) < 600) return;
    this.lastSay.set(pid, now);
    const state = await this.loadState();
    const who = state.players[pid]?.name;
    if (!who) return;
    const body = JSON.stringify({ type: "say", pid, name: who, id, text });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(body);
      } catch {
        /* closing */
      }
    }
  }

  /** Validate → apply → save → broadcast, against freshly loaded state. */
  private async commit(pid: string, action: Record<string, unknown>, connId: string | null) {
    let state = await this.loadState();

    // A move that arrives after the time limit loses to the clock.
    const now = Date.now();
    if (state.phase === "racing" && state.round?.endAt && now >= state.round.endAt) {
      state = logic.applyAction(state, SYSTEM, { kind: "tick", _t: { now } });
      if (pid === SYSTEM) action = { kind: "tick", _t: { now } };
    }

    const verdict = logic.validateAction(state, pid, action);
    if (!verdict.ok) {
      await this.ctx.storage.put("state", state);
      this.error(connId, verdict.error ?? "Not allowed.");
      if (state.phase === "over") await this.broadcast(state);
      await this.schedule(state);
      return;
    }
    const next = logic.applyAction(state, pid, action) as GameState;
    await this.ctx.storage.put("state", next);
    await this.schedule(next);

    // A finished daily attempt goes on that day's leaderboard.
    if (state.phase === "racing" && next.phase === "over" && next.settings.daily && next.round?.winner) {
      const unit = next.round.units[next.round.winner];
      const who: string | undefined = unit?.members?.[0];
      if (unit && who) {
        await this.postScore(next.settings.daily, {
          pid: who,
          name: unit.name,
          clicks: unit.clicks,
          ms: unit.finishMs ?? 0,
          leaves: next.round.watch?.[who]?.leaves ?? 0,
        });
      }
    }
    await this.broadcast(next);
    await this.syncDirectory(next);
  }

  private async schedule(state: GameState): Promise<void> {
    if (state.phase === "racing" && state.round?.endAt) {
      await this.ctx.storage.setAlarm(state.round.endAt + 25);
    } else if (state.phase === "lobby" && state.settings.visibility === "public" && !state.settings.daily) {
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // ── public parties ─────────────────────────────────────────────────────

  private lastListing = "";

  private async onlineCount(state: GameState): Promise<number> {
    const online = new Set(Object.values(await this.loadConns()));
    return state.order.filter((p: string) => online.has(p)).length;
  }

  /** Keeps this party on (or off) the public list: listed while public, waiting to start, and someone is here. */
  private async syncDirectory(state: GameState, force = false): Promise<void> {
    if (!this.name || this.name === "dir" || this.name.startsWith("lb-") || /^DAILY/.test(this.name)) return;
    const players = await this.onlineCount(state);
    const listedNow = state.settings.visibility === "public" && state.phase === "lobby" && players > 0;
    if (!listedNow) {
      if (await this.ctx.storage.get<boolean>("listed")) {
        await this.dirCall("remove", { room: this.name });
        await this.ctx.storage.put("listed", false);
      }
      this.lastListing = "";
      return;
    }
    const entry = {
      room: this.name,
      host: state.players[state.host]?.name ?? "Host",
      players,
      mode: state.settings.mode,
      rounds: state.settings.rounds,
    };
    const sig = JSON.stringify(entry);
    if (!force && sig === this.lastListing) return;
    this.lastListing = sig;
    await this.dirCall("upsert", entry);
    await this.ctx.storage.put("listed", true);
  }

  private async dirCall(op: "upsert" | "remove", body: unknown): Promise<void> {
    try {
      await this.env.ROOMS.get(this.env.ROOMS.idFromName("dir")).fetch(`https://dir/${op}`, {
        method: "POST",
        headers: { "x-room": "dir", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("directory call failed:", err instanceof Error ? err.stack : String(err));
    }
  }

  private async dirList(): Promise<Response> {
    const all = (await this.ctx.storage.get<Listing[]>("list")) ?? [];
    const fresh = all.filter((e) => Date.now() - e.at < 150000);
    if (fresh.length !== all.length) await this.ctx.storage.put("list", fresh);
    const parties = fresh
      .sort((a, b) => b.at - a.at)
      .slice(0, 30)
      .map(({ room, host, players, mode, rounds }) => ({ room, host, players, max: logic.meta.maxPlayers, mode, rounds }));
    return json({ parties });
  }

  private async dirUpsert(body: unknown): Promise<Response> {
    if (!isRecord(body)) return json({ error: "bad entry" }, 400);
    const room = typeof body.room === "string" ? body.room : "";
    const host = typeof body.host === "string" ? body.host.replace(/[<>]/g, "").slice(0, 20) : "";
    const players = Number(body.players);
    const rounds = Number(body.rounds);
    const mode = typeof body.mode === "string" ? body.mode : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(room) || !host || !Number.isInteger(players) || players < 0 || players > 24 || !["race", "fewest", "teams", "elim"].includes(mode) || !Number.isInteger(rounds)) {
      return json({ error: "bad entry" }, 400);
    }
    const list = ((await this.ctx.storage.get<Listing[]>("list")) ?? []).filter((e) => e.room !== room && Date.now() - e.at < 150000);
    list.push({ room, host, players, mode, rounds, at: Date.now() });
    await this.ctx.storage.put("list", list.slice(-200));
    return json({ ok: true });
  }

  private async dirRemove(body: unknown): Promise<Response> {
    if (!isRecord(body) || typeof body.room !== "string") return json({ error: "bad entry" }, 400);
    const list = ((await this.ctx.storage.get<Listing[]>("list")) ?? []).filter((e) => e.room !== body.room);
    await this.ctx.storage.put("list", list);
    return json({ ok: true });
  }

  // ── daily challenge ────────────────────────────────────────────────────

  private lbRoom(date: string): DurableObjectStub {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName("lb-" + date));
  }

  /** A solo daily attempt gets today's route from the leaderboard room. */
  private async ensureDaily(): Promise<void> {
    if (!/^DAILY[A-Za-z0-9]{3,}$/.test(this.name)) return;
    const state = await this.loadState();
    if (state.settings.daily || state.phase !== "lobby") return;
    try {
      const date = etDate();
      const res = await this.lbRoom(date).fetch("https://lb/daily", { headers: { "x-room": "lb-" + date } });
      if (!res.ok) return;
      const j = (await res.json()) as Route;
      await this.commit(
        SYSTEM,
        { kind: "dailySetup", _t: { now: Date.now(), date, route: { start: j.start, target: j.target, hops: j.hops, level: j.level } } },
        null,
      );
    } catch (err) {
      console.error("daily setup failed:", err instanceof Error ? err.stack : String(err));
    }
  }

  private async postScore(date: string, entry: Entry): Promise<void> {
    try {
      await this.lbRoom(date).fetch("https://lb/submit", {
        method: "POST",
        headers: { "x-room": "lb-" + date, "content-type": "application/json" },
        body: JSON.stringify(entry),
      });
    } catch (err) {
      console.error("daily submit failed:", err instanceof Error ? err.stack : String(err));
    }
  }

  /** Today's route (made once, by whoever asks first). Concurrent askers share one lookup. */
  private routing: Promise<Route | null> | null = null;

  private async dailyRoute(): Promise<Route | null> {
    // "route2": routes made before the difficulty schedule existed are ignored.
    const saved = await this.ctx.storage.get<Route>("route2");
    if (saved) return saved;
    if (!this.routing) {
      this.routing = (async () => {
        try {
          const level = dailyLevel(this.name.slice(3));
          const pinned = this.env.DAILY_FIXED?.split("~");
          const made: RouteResult =
            pinned && pinned.length === 2
              ? { ok: true, start: pinned[0] as string, target: pinned[1] as string, hops: 1 }
              : await randomRoute(level, [], { daily: true });
          if (!made.ok) return null;
          const again = await this.ctx.storage.get<Route>("route2");
          if (again) return again;
          const route = { start: made.start, target: made.target, hops: made.hops, level };
          await this.ctx.storage.put("route2", route);
          return route;
        } finally {
          this.routing = null;
        }
      })();
    }
    return this.routing;
  }

  private async dailyInfo(pid: string): Promise<Response> {
    const route = await this.dailyRoute();
    if (!route) return json({ error: "Today's challenge isn't ready. Try again in a moment." }, 503);
    const board = (await this.ctx.storage.get<Entry[]>("board")) ?? [];
    const idx = pid ? board.findIndex((e) => e.pid === pid) : -1;
    return json({
      date: this.name.slice(3),
      ...route,
      total: board.length,
      top: board.slice(0, 20).map((e, i) => ({
        rank: i + 1,
        name: e.name,
        clicks: e.clicks,
        ms: e.ms,
        leaves: e.leaves,
        you: idx === i,
      })),
      you: idx >= 0 ? { rank: idx + 1, clicks: board[idx]?.clicks, ms: board[idx]?.ms } : null,
    });
  }

  private async dailySubmit(body: unknown): Promise<Response> {
    if (!isRecord(body)) return json({ error: "bad entry" }, 400);
    const pid = typeof body.pid === "string" ? body.pid.slice(0, 64) : "";
    const name = typeof body.name === "string" ? body.name.replace(/[<>]/g, "").trim().slice(0, 20) : "";
    const clicks = Number(body.clicks);
    const ms = Number(body.ms);
    const leaves = Math.max(0, Math.min(99, Math.floor(Number(body.leaves) || 0)));
    if (!pid || !name || !Number.isInteger(clicks) || clicks < 1 || clicks > 500 || !Number.isFinite(ms) || ms < 0) {
      return json({ error: "bad entry" }, 400);
    }
    const entry: Entry = { pid, name, clicks, ms: Math.round(ms), leaves };
    let board = (await this.ctx.storage.get<Entry[]>("board")) ?? [];
    const i = board.findIndex((e) => e.pid === pid);
    const old = i >= 0 ? board[i] : undefined;
    if (!old) board.push(entry);
    else if (entry.clicks < old.clicks || (entry.clicks === old.clicks && entry.ms < old.ms)) board[i] = entry;
    else old.name = name;
    board.sort((a, b) => a.clicks - b.clicks || a.ms - b.ms);
    board = board.slice(0, 300);
    await this.ctx.storage.put("board", board);
    return json({ rank: board.findIndex((e) => e.pid === pid) + 1, total: board.length });
  }
}
