# Colyseus on Cloudflare Durable Objects

A proof of concept: a whole [Colyseus](https://colyseus.io) 0.18 server running
inside **one** Durable Object, with unmodified `@colyseus/core` and an
unmodified `@colyseus/sdk` client.

The Worker forwards every request to a single named object. That object boots a
Colyseus `Server` with a custom transport, which answers HTTP through the
Colyseus router and upgrades WebSockets with `WebSocketPair`.

> **Status: experiment.** One object is one process. Nothing here scales past
> it — see [Limitations](#limitations).

## What's in here

| Path | What it is |
|---|---|
| `src/DurableObjectTransport.ts` | The transport (~150 lines). The only piece Colyseus was missing. |
| `src/index.ts`, `src/MyRoom.ts` | The minimal app: one room, one Durable Object. |
| `wrangler.jsonc` | `nodejs_compat`, one Durable Object binding, one migration. |
| `test/client.mjs` | End-to-end check with a real SDK client. |
| `test/redeploy.mjs` | Shows what connected clients see across a redeploy. |
| `src/tpr.ts`, `wrangler.tpr.jsonc` | Benchmark app: a real game's room on the same transport. |
| `bench/ramp.ts`, `bench/do-analytics.sh` | CCU ramp driver and Cloudflare CPU analytics. |

## Run it

```sh
npm install
npm run dev        # wrangler dev, http://localhost:8787
npm test           # in another terminal
```

Deploy and test the deployed URL:

```sh
npm run deploy
node test/client.mjs https://<name>.<subdomain>.workers.dev
```

The test covers the HTTP routes, two clients sharing a room, state sync, a
message round trip, the simulation interval, and `onLeave`.

## The minimum setup

Dependencies are `@colyseus/core` and `@colyseus/schema`, plus `wrangler`. No
`ws-transport`, `@colyseus/tools` or express.

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "COLYSEUS", "class_name": "ColyseusServer" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ColyseusServer"] }]
}
```

```ts
// src/index.ts
export class ColyseusServer extends DurableObject<Env> {
  private transport = new DurableObjectTransport();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const server = new Server({ transport: this.transport, greet: false, gracefullyShutdown: false });
    server.define("my_room", MyRoom);
    this.ready = server.listen(0);
  }

  async fetch(request: Request) {
    await this.ready;
    return this.transport.fetch(request);
  }
}

export default {
  fetch: (request, env) => env.COLYSEUS.getByName("main").fetch(request),
} satisfies ExportedHandler<Env>;
```

Two things that are easy to get wrong:

- **Binary frames arrive as `Blob`** on recent compatibility dates. The
  transport sets `ws.binaryType = "arraybuffer"`.
- **No WebSocket Hibernation.** Rooms live in memory, so sockets are accepted
  with plain `accept()`. The object stays pinned, and billed, while anyone is
  connected.

## Limitations

**Single process only.** Everything was tested with one Durable Object holding
every room. Not attempted:

- More than one object. Colyseus scales out through a shared `Presence` and
  matchmaking `Driver` (Redis, normally); neither exists here, so a second
  object would be a second, unrelated server.
- One object per room, the natural Durable Objects shape. It needs matchmaking
  that can see across objects.
- Express, `@colyseus/monitor`, `@colyseus/playground`, `@colyseus/auth`. The
  transport has no `getExpressApp()`.

**Rooms do not survive a restart.** State is in memory only.

- A redeploy does not disconnect anyone at first. The object kept running the
  *old* code for 4–5 minutes, then restarted.
- Clients then get `onDrop` with code `1006`. The SDK's automatic reconnection
  fails on its first try (`seat reservation expired`), followed by `onLeave`
  with code `4003`.
- No shutdown hook runs: no close code, no `onLeave`, no `onDispose` on the
  server.

Reproduce with `node test/redeploy.mjs <url>` (it deploys for real and takes
about eight minutes).

**Only client-initiated leaves were exercised.** The transport emits `close`
itself on a server-side `client.leave()`; that path is untested.

## Benchmark: how many players fit in one object?

The benchmark runs the `GameRoom` of
[Trash Panda Royale](https://github.com/pixijs/open-games/tree/main/trash-panda-royale)
— a 30 Hz, 16-players-per-room battle royale with traffic and pedestrians —
and ramps in bots that send one input per simulation step.

Locally, on workerd (Apple M1 Pro, bots on the same machine):

| CCU | Rooms | CPU (% of one core) | Sim steps/s per room | State updates/s per bot |
|---|---|---|---|---|
| 16 | 1 | 12 | 30.1 | 29.5 |
| 64 | 4 | 38 | 29.8 | 29.1 |
| 128 | 8 | 69 | 30.0 | 28.3 |
| 160 | 10 | 85 | 28.6 | 26.0 |
| 192 | 12 | 90 | 29.0 | 23.1 |
| 224 | 14 | 91 | 27.0 | 16.0 |

CPU grows linearly, about 0.55% of a core per player, and the game degrades
from about 160 CCU.

On Cloudflare, a short ramp to 48 CCU held 30 steps/s per room with no drops.
Cloudflare's analytics put it at about 4.3 ms of CPU per player-second, which
extrapolates to a full core near 230 CCU. Memory was 40 MB with 3 rooms against
a 9 MB idle baseline, so the 128 MB limit may bind first. Both figures rest on
one partially captured minute; production was **not** pushed to saturation.

### The free plan runs out of requests long before CPU

The Workers Free plan includes 100,000 Durable Object requests per day, and
incoming WebSocket messages count at 20:1. A game sending 30 inputs per second
per player gets about **18.5 player-hours per day** — 16 players for 69
minutes. After that, requests to the object fail until 00:00 UTC.

The 20:1 ratio is documented for billing; that it also applies to the free
daily cap is an assumption. A ramp to saturation would spend 35–80% of that
quota, which is why it was not run.

### Running the benchmark

It expects a checkout of [pixijs/open-games](https://github.com/pixijs/open-games) at `../../pixijs-open-games`
relative to this repo, with its dependencies installed. Change the import in
`src/tpr.ts` and set `GAME_DIR` if yours is elsewhere.

```sh
npm run dev:tpr
GAME=../../pixijs-open-games/trash-panda-royale
$GAME/node_modules/.bin/tsx bench/ramp.ts \
  --endpoint http://localhost:8788 --steps 16,32,64,128 --hold 12 \
  --pid "$(pgrep -f 'workerd serve' | paste -sd, -)"
```

Run it with the game's own `tsx`, so the SDK and the input schema load as one
copy. Against a deployed Worker, pass `--budget <messages>` to stop before the
quota does.

`bench/do-analytics.sh <since ISO time> [namespace id]` prints per-minute CPU,
memory and message counts from Cloudflare's GraphQL analytics. It reuses
wrangler's stored login (macOS config path) and lags real time by 10–15
minutes. `wrangler tail` does not report Durable Object CPU.

The server exposes `/__stats` (CCU, rooms, simulation steps, message counters).
Inside workerd the clock stands still while code runs, so CPU cannot be timed
from within the object.
