/**
 * The Worker entry — everything that is not a static file lands here.
 *
 * Its whole job is routing a WebSocket upgrade to the right room. Static files
 * (`dist/client`) are served by the platform BEFORE this runs, so `/`,
 * `/client.js` and friends never reach this code.
 *
 * The `Room` re-export is required: a Durable Object class must be exported from
 * the Worker's entry module or the class does not ship and the deploy fails.
 */

import type { Env } from "./env";
import { Room } from "./room";
import { etDate } from "./wiki";

export { Room };

/** `/ws` and `/ws/<room>` — the only server-side route a game has by default. */
const WS_PREFIX = "/ws";

/**
 * A room name comes from the URL, so it is untrusted: it is used as a Durable
 * Object name, and an unbounded or exotic value would let anyone mint unlimited
 * rooms with unreadable ids. Restrict it to a short, boring label.
 */
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_ROOM = "main";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === WS_PREFIX || url.pathname.startsWith(WS_PREFIX + "/")) {
      // Reject non-upgrade traffic here rather than paying for a DO wake-up.
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a websocket upgrade", { status: 426 });
      }
      const raw = url.pathname.slice(WS_PREFIX.length).replace(/^\/+/, "");
      // Trailing-slash and bare `/ws` both mean the default room, matching the
      // previous engine's shard naming.
      const room = raw === "" ? DEFAULT_ROOM : raw;
      // "lb-" names are the daily leaderboards, which only this Worker may reach.
      if (!ROOM_RE.test(room) || /^lb-/i.test(room) || /^dir$/i.test(room)) {
        return new Response("invalid room name", { status: 400 });
      }
      // One DO instance per room name. Same name anywhere in the world = same
      // room, so all its players share one authoritative state.
      const id = env.ROOMS.idFromName(room);
      const headers = new Headers(request.headers);
      headers.set("x-room", room);
      return env.ROOMS.get(id).fetch(new Request(request, { headers }));
    }

    // Parties whose host made them public and that are still waiting to start.
    if (url.pathname === "/api/public" && request.method === "GET") {
      const res = await env.ROOMS.get(env.ROOMS.idFromName("dir")).fetch("https://dir/list", { headers: { "x-room": "dir" } });
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // Today's daily challenge: the route and the top of the leaderboard.
    if (url.pathname === "/api/daily" && request.method === "GET") {
      // DAILY_TEST is only ever set by a local test run, to preview other days.
      const asked = url.searchParams.get("date") ?? "";
      const lb = "lb-" + (env.DAILY_TEST && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : etDate());
      const pid = (url.searchParams.get("pid") ?? "").slice(0, 64);
      const res = await env.ROOMS.get(env.ROOMS.idFromName(lb)).fetch(
        `https://lb/daily?pid=${encodeURIComponent(pid)}`,
        { headers: { "x-room": lb } },
      );
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // A path that is neither a static file nor /ws. `not_found_handling: "none"`
    // means the platform already tried the assets, so this is a real 404 —
    // except for client-side routes, which want the app shell back.
    if (request.method === "GET" && request.headers.get("Accept")?.includes("text/html")) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
