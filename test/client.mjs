import assert from "node:assert/strict";
import { Client } from "@colyseus/sdk";

const endpoint = process.argv[2] || "http://localhost:8787";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (name) => console.log(`✓ ${name}`);

assert.match(await (await fetch(endpoint)).text(), /^Colyseus /);
assert.equal(await (await fetch(`${endpoint}/__healthcheck`)).text(), "OK");
step("http routes");

const a = await new Client(endpoint).joinOrCreate("my_room");
const b = await new Client(endpoint).joinOrCreate("my_room");
assert.equal(a.roomId, b.roomId);
step(`two clients share room ${a.roomId}`);

await sleep(500);
assert.equal(a.state.players.size, 2);
assert.equal(b.state.players.size, 2);
step("initial state sync");

const moved = new Promise((resolve) => a.onMessage("moved", resolve));
a.send("move", { x: 10, y: 20 });
assert.deepEqual(await moved, { x: 10, y: 20 });
step("message round trip");

await sleep(300);
assert.equal(b.state.players.get(a.sessionId).x, 10);
step("state patch reaches the other client");

const ticks = b.state.ticks;
await sleep(1000);
assert.ok(b.state.ticks - ticks >= 8, `simulation interval stalled (${b.state.ticks - ticks} ticks/s)`);
step(`simulation interval runs (${b.state.ticks - ticks} ticks/s)`);

await a.leave();
await sleep(300);
assert.equal(b.state.players.size, 1);
step("onLeave after consented leave");

await b.leave();
console.log("\nall good →", endpoint);
process.exit(0);
