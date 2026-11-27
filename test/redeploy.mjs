// Holds two clients in a room, redeploys the Worker, and logs what each client sees.
import { spawn } from "node:child_process";
import { Client } from "@colyseus/sdk";

const endpoint = process.argv[2];
if (!endpoint) { throw new Error("usage: node test/redeploy.mjs <deployed url>"); }

const start = Date.now();
const log = (who, ...args) => console.log(`[${((Date.now() - start) / 1000).toFixed(1).padStart(5)}s] ${who}`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rooms = {};
for (const name of ["A", "B"]) {
  const room = rooms[name] = await new Client(endpoint).joinOrCreate("my_room");
  log(name, `joined room ${room.roomId} as ${room.sessionId}`);
  room.onDrop((code, reason) => log(name, `onDrop code=${code} ${reason ?? ""}`));
  room.onReconnect(() => log(name, `onReconnect → ticks=${room.state.ticks} players=${room.state.players.size}`));
  room.onLeave((code, reason) => log(name, `onLeave code=${code} ${reason ?? ""}`));
  room.onError((code, message) => log(name, `onError code=${code} ${message ?? ""}`));
}

await sleep(7000); // past the SDK's 5s minUptime for automatic reconnection
log("-", `before deploy: ticks=${rooms.A.state.ticks} players=${rooms.A.state.players.size}`);

log("-", "wrangler deploy…");
await new Promise((resolve, reject) => {
  // a changed var guarantees a new version even when the code is identical
  const deploy = spawn("npx", ["wrangler", "deploy", "--var", `BUILD:${Date.now()}`], { stdio: "ignore" });
  deploy.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`deploy exited with ${code}`)));
});
log("-", "deploy finished");

// the object restarts minutes after the deploy, not with it
for (let i = 0; i < Number(process.argv[3] || 84); i++) {
  if (i % 12 === 0) { log("-", `A.ticks=${rooms.A.state.ticks} B.ticks=${rooms.B.state.ticks}`); }
  await sleep(5000);
}

const fresh = await new Client(endpoint).joinOrCreate("my_room");
await sleep(500);
log("C", `fresh join → room ${fresh.roomId} ticks=${fresh.state.ticks} players=${fresh.state.players.size}`);
process.exit(0);
