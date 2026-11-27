// Benchmark entry: Trash Panda Royale's GameRoom on a single Durable Object.
import { DurableObject } from "cloudflare:workers";
import { Server, matchMaker } from "@colyseus/core";
import { DurableObjectTransport } from "./DurableObjectTransport.ts";
import { GameRoom } from "../../../pixijs-open-games/trash-panda-royale/src/server/GameRoom.ts";

interface Env {
  COLYSEUS: DurableObjectNamespace<TrashPandaServer>;
}

const LAG_PROBE_MS = 50;
const bench = { bootedAt: 0, steps: 0, lagSamples: 0, lagSum: 0, lagMax: 0 };

class BenchRoom extends GameRoom {
  // @ts-ignore private upstream
  step(ctx: any) {
    bench.steps++;
    // @ts-ignore
    return super.step(ctx);
  }
}

export class TrashPandaServer extends DurableObject<Env> {
  private transport = new DurableObjectTransport();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const server = new Server({ transport: this.transport, greet: false, gracefullyShutdown: false });
    server.define("town", BenchRoom);
    this.ready = server.listen(0);

    // workerd's clock stands still while code runs, so CPU can't be timed from
    // inside: a timer firing late is the visible sign of a busy event loop
    bench.bootedAt = Date.now();
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - last - LAG_PROBE_MS);
      last = now;
      bench.lagSamples++;
      bench.lagSum += lag;
      if (lag > bench.lagMax) { bench.lagMax = lag; }
    }, LAG_PROBE_MS);
  }

  async fetch(request: Request) {
    await this.ready;

    if (new URL(request.url).pathname === "/__stats") {
      const stats = Response.json({
        now: Date.now(),
        ...bench,
        ccu: matchMaker.stats.local.ccu,
        rooms: matchMaker.stats.local.roomCount,
        ...DurableObjectTransport.stats,
      });
      bench.lagMax = 0; // max since the previous poll
      return stats;
    }

    return this.transport.fetch(request);
  }
}

export default {
  fetch(request, env) {
    return env.COLYSEUS.getByName("main").fetch(request);
  },
} satisfies ExportedHandler<Env>;
