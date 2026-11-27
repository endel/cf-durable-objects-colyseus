import { DurableObject } from "cloudflare:workers";
import { Server } from "@colyseus/core";
import { DurableObjectTransport } from "./DurableObjectTransport.ts";
import { MyRoom } from "./MyRoom.ts";

interface Env {
  COLYSEUS: DurableObjectNamespace<ColyseusServer>;
}

export class ColyseusServer extends DurableObject<Env> {
  private transport = new DurableObjectTransport();
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const server = new Server({
      transport: this.transport,
      greet: false,
      gracefullyShutdown: false, // no process signals in workerd
    });
    server.define("my_room", MyRoom);

    this.ready = server.listen(0);
  }

  async fetch(request: Request) {
    await this.ready;
    return this.transport.fetch(request);
  }
}

export default {
  fetch(request, env) {
    // one name, one object: the whole Colyseus server is a single instance
    return env.COLYSEUS.getByName("main").fetch(request);
  },
} satisfies ExportedHandler<Env>;
