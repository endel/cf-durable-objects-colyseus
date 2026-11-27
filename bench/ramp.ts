/**
 * Ramps wandering bots into Trash Panda Royale and samples the server's
 * `/__stats` at every plateau, to see how load grows with CCU.
 *
 *   tsx bench/ramp.ts --endpoint http://localhost:8788 --steps 8,16,32 --hold 20 [--pid <workerd pid>] [--budget <messages>]
 *
 * Run it with the game's own tsx: the SDK and the input schema must come from
 * the game's node_modules, as one copy.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

// same checkout src/tpr.ts imports the room from
const GAME = process.env.GAME_DIR || new URL("../../../pixijs-open-games/trash-panda-royale", import.meta.url).pathname;
const gameRequire = createRequire(`${GAME}/package.json`);
const { Client } = await import(gameRequire.resolve("@colyseus/sdk"));
const { TICK_RATE, Weapon } = await import(`${GAME}/src/shared/constants.ts`);
const { PlayerInput } = await import(`${GAME}/src/shared/schema.ts`);

const { values: args } = parseArgs({
  options: {
    endpoint: { type: "string", default: "http://localhost:8788" },
    steps: { type: "string", default: "8,16,32" },
    hold: { type: "string", default: "20" },
    /** Sample this process's CPU with `ps` (a local workerd). */
    pid: { type: "string" },
    /** Stop ramping once the server has received this many WebSocket messages. */
    budget: { type: "string" },
    out: { type: "string" },
  },
});

const endpoint = args.endpoint!;
const steps = args.steps!.split(",").map(Number);
const holdMs = Number(args.hold) * 1000;
const budget = args.budget ? Number(args.budget) : Infinity;
const SETTLE_MS = 4000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const getStats = async () => (await fetch(`${endpoint}/__stats`)).json() as Promise<any>;

const bots: any[] = [];
const counters = { patches: 0, joinFailed: 0, dropped: 0, joinMs: [] as number[] };
let stopping = false;

async function addBot() {
  const startedAt = performance.now();
  let room: any;
  try {
    room = await new Client(endpoint).joinOrCreate("town", { name: `Bot${Math.floor(Math.random() * 900 + 100)}` });
  } catch (e: any) {
    counters.joinFailed++;
    if (counters.joinFailed <= 3) { console.log(`  join failed: ${e.code ?? ""} ${e.message}`); }
    return;
  }
  counters.joinMs.push(performance.now() - startedAt);

  // same wandering bot as the game's loadtest/bots.ts: one input per fixed step
  const input = room.input({ type: PlayerInput });
  let dir = Math.random() * Math.PI * 2;
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    if (tick % 60 === 0) dir += (Math.random() - 0.5) * 2.5;
    const d = input.data as any;
    d.mx = Math.round(Math.sin(dir) * 100);
    d.mz = Math.round(Math.cos(dir) * 100);
    d.throttle = 100;
    d.steer = tick % 90 < 20 ? 60 : 0;
    d.aim = Math.atan2(Math.sin(dir + 0.4), Math.cos(dir + 0.4));
    d.fire = tick % 45 === 0;
    d.nade = tick % 400 < 12;
    d.sprint = tick % 300 > 150;
    d.jump = tick % 97 === 0;
    d.use = tick % 600 === 300;
    d.weapon = Weapon.Pistol;
    input.send();
  }, 1000 / TICK_RATE);

  room.onMessage("*", () => {});
  room.onStateChange(() => counters.patches++);
  room.onLeave((code: number) => {
    clearInterval(timer);
    const i = bots.indexOf(room);
    if (i >= 0) { bots.splice(i, 1); }
    if (!stopping) {
      counters.dropped++;
      if (counters.dropped <= 3) { console.log(`  bot dropped: code ${code}`); }
    }
  });
  bots.push(room);
}

// this process's own event-loop lag: a slow driver would look like a slow server
let driverLagMax = 0, driverLast = performance.now();
setInterval(() => {
  const now = performance.now();
  driverLagMax = Math.max(driverLagMax, now - driverLast - 50);
  driverLast = now;
}, 50);

// summed over a comma-separated list: wrangler dev runs more than one workerd
const cpuOf = (pids: string) => execSync(`ps -o %cpu= -p ${pids}`).toString().trim().split("\n").reduce((sum, v) => sum + Number(v.trim().replace(",", ".")), 0); // some locales print 12,3

const rows: any[] = [];
console.log(`endpoint ${endpoint} · steps ${steps.join(",")} · hold ${holdMs / 1000}s`);

for (const target of steps) {
  const before = await getStats();
  if (before.messagesIn >= budget) { console.log(`message budget reached (${before.messagesIn}), stopping`); break; }

  counters.joinMs = [];
  const failedBefore = counters.joinFailed;
  while (bots.length < target && counters.joinFailed - failedBefore < 10) {
    await Promise.all(Array.from({ length: Math.min(8, target - bots.length) }, addBot));
  }
  await sleep(SETTLE_MS);

  const a = await getStats();
  counters.patches = 0;
  driverLagMax = 0;
  const droppedBefore = counters.dropped;
  const cpu: number[] = [];
  const holdUntil = Date.now() + holdMs;
  while (Date.now() < holdUntil) {
    await sleep(1000);
    if (args.pid) { cpu.push(cpuOf(args.pid)); }
  }
  const connected = bots.length;
  const b = await getStats();

  const secs = (b.now - a.now) / 1000;
  const lagSamples = b.lagSamples - a.lagSamples;
  const row = {
    target,
    connected,
    serverCcu: b.ccu,
    rooms: b.rooms,
    restarted: b.bootedAt !== a.bootedAt,
    stepsPerRoom: +((b.steps - a.steps) / secs / Math.max(1, b.rooms)).toFixed(1),
    lagAvgMs: +((b.lagSum - a.lagSum) / Math.max(1, lagSamples)).toFixed(2),
    lagMaxMs: b.lagMax,
    msgInPerSec: Math.round((b.messagesIn - a.messagesIn) / secs),
    msgOutPerSec: Math.round((b.messagesOut - a.messagesOut) / secs),
    kbOutPerSec: +((b.bytesOut - a.bytesOut) / secs / 1024).toFixed(1),
    patchesPerBot: +(counters.patches / (holdMs / 1000) / Math.max(1, connected)).toFixed(1),
    joinMsAvg: Math.round(counters.joinMs.reduce((x, y) => x + y, 0) / Math.max(1, counters.joinMs.length)),
    joinFailed: counters.joinFailed - failedBefore,
    dropped: counters.dropped - droppedBefore,
    cpuPct: cpu.length ? +(cpu.reduce((x, y) => x + y, 0) / cpu.length).toFixed(1) : undefined,
    driverLagMaxMs: Math.round(driverLagMax),
    messagesInTotal: b.messagesIn,
  };
  rows.push(row);
  console.log(JSON.stringify(row));

  if (connected < target * 0.8) { console.log("could not hold the target CCU, stopping"); break; }
}

stopping = true;
if (args.out) { writeFileSync(args.out, JSON.stringify(rows, null, 2)); }
await Promise.all(bots.slice().map((room) => room.leave().catch(() => {})));
process.exit(0);
