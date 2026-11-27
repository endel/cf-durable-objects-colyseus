import { Room, type Client } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";

const Player = schema({ x: t.number(), y: t.number() }, "Player");
const State = schema({ players: t.map(Player), ticks: t.number() }, "State");

export class MyRoom extends Room {
  state = new State();

  onCreate() {
    this.onMessage("move", (client, message: { x: number, y: number }) => {
      const player = this.state.players.get(client.sessionId)!;
      player.x = message.x;
      player.y = message.y;
      client.send("moved", message);
    });

    this.state.ticks = 0;
    this.setSimulationInterval(() => this.state.ticks++, 100);
  }

  onJoin(client: Client) {
    this.state.players.set(client.sessionId, new Player());
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }
}

export type MyRoomState = SchemaType<typeof State>;
