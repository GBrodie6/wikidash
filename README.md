# WikiDash

A multiplayer Wikipedia race game. Everyone starts on the same article and tries to reach the target article using only the links on each page. The first one there wins.

Live at https://wikidash5.higgsfield.app

## What it does

- Party rooms with a short code. Private by default. The host can list a party on the public list.
- Four modes: race, fewest clicks, teams, and elimination. A match can run 1, 3, 5 or 7 rounds.
- Host rules: back button, find in page, leaving the tab, click limit, time limit, banned pages, navbox links, and whether players can see each other's positions.
- Every click is checked on the server against Wikipedia's link data, so a forged move is rejected.
- Random routes by difficulty, a daily challenge with a leaderboard, a route map, and a replay of each round.
- A host and co-hosts run the party. Players who are not hosts can suggest pages in the lobby.

## How it is laid out

- `src/logic.js`: the game rules, as pure functions over JSON state.
- `src/room.ts`: one Durable Object per party. It owns the sockets and storage, keeps time, does the Wikipedia lookups, then hands each action to `logic.js`.
- `src/wiki.ts`: Wikipedia API helpers, click verification and random route generation.
- `src/worker.ts`: routing for `/ws/<room>`, `/api/public` and `/api/daily`.
- `src/protocol.ts`: checks every message from a browser before the room acts on it.
- `public/`: the client. Plain JavaScript modules and one stylesheet.
- `scripts/`: the build script and a check that `logic.js` stays pure.

## Running it

It runs on Cloudflare Workers.

```
bun install
bun run dev
```

`bun run build` writes the Worker and the static files to `dist/`.

The hosted copy is deployed through Higgsfield, which generates the real deploy config from `app.manifest.json`. `wrangler.jsonc` is only for local development.
