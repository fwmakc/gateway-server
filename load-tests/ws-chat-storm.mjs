#!/usr/bin/env node
/**
 * Wave 16 WS chat storm: N JWT-authenticated socket.io clients through the
 * nginx edge, one publisher flooding a shared channel, and a strict fan-out
 * invariant — EVERY receiver must end up with exactly MSGS unique ids
 * (0 lost, 0 duplicated), counting live deliveries plus a sync-based
 * gap-fill after the fact.
 *
 * Two phases:
 *   host   (default) — all clients through nginx (:8080, ip_hash bucket);
 *                      CHAOS=1 additionally docker-stops the replica that
 *                      holds the sockets mid-flood: clients must fail over
 *                      to the survivor and still converge to 0/0.
 *   direct (DIRECT=1, inside the storm-runner container) — half the
 *                      clients connect to each replica by container name;
 *                      a publisher on one replica must reach the other
 *                      replica's subscribers through the redis adapter.
 *                      CHAOS=1 works here too when the runner mounts the
 *                      docker socket (the killed replica is restarted before
 *                      the converge phase, so its clients reconnect).
 *
 * Ceiling mode: run with load-tests/docker-compose.chatstorm.yml (auth
 * throttler and chat buckets raised) and the user pool from
 * seed-chat-storm.sql. The nginx edge stays production — the script ramps
 * handshakes to stay under the chat_limit zone (30r/s burst 50).
 *
 * Usage:
 *   CLIENTS=150 MSGS=200 CHAOS=1 RAMP_MS=200 node load-tests/ws-chat-storm.mjs
 *   docker compose -f docker-compose.yml -f load-tests/docker-compose.chatstorm.yml \
 *     run --rm --entrypoint sh storm-runner \
 *     -c "apk add -q docker-cli && npm i socket.io-client@4 --no-save --loglevel=error && \
 *         DIRECT=1 CLIENTS=500 MSGS=600 CHAOS=1 BASE=http://nginx:80 node ws-chat-storm.mjs"
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { io } from "socket.io-client";

const BASE = process.env.BASE || "http://localhost:8080";
const DIRECT = process.env.DIRECT === "1";
const CLIENTS = Number(process.env.CLIENTS || (DIRECT ? 100 : 500));
const MSGS = Number(process.env.MSGS || 600);
const CHAOS = process.env.CHAOS === "1"; // needs docker CLI: on the host (edge) or in the runner with the docker socket mounted (direct)
const CHAOS_AT = Number(process.env.CHAOS_AT || 0.4); // kill after this share of the flood
const RAMP_MS = Number(process.env.RAMP_MS || 150); // handshake pacing (~4.5 polling reqs per client under chat_limit 30r/s)
const LOGIN_WORKERS = Number(process.env.LOGIN_WORKERS || 8);
const DRAIN_SEC = Number(process.env.DRAIN_SEC || 90);
const STORM_DEBUG = process.env.STORM_DEBUG === "1";
const PASSWORD = "LoadPass123!";

const proj = (n) => `load_${n}@test.local`;
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const ackAt = new Map(); // messageId -> publisher clock at ack
const latencies = []; // arrival - ackAt per (receiver, message); -1 = ack unseen
let dupLive = 0;   // same id delivered twice over message.new — a real double-broadcast
let dupSync = 0;   // sync overlap over an already-received range — by-design recovery fill

async function login(userId) {
  const url = `${BASE}/account/methods/login`;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: proj(userId), password: PASSWORD }),
      });
      if (res.status === 429 || res.status === 503) {
        await sleep(1200 + Math.random() * 800);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (json?.access_token) return json.access_token;
      await sleep(1000);
    } catch { await sleep(1000); }
  }
  throw new Error(`login failed for ${proj(userId)}`);
}

const targetFor = (i) =>
  DIRECT
    ? i % 2 === 0
      ? "http://gateway-server-chat-server-1:3004"
      : "http://gateway-server-chat-server-2:3004"
    : BASE;

// ── shared state ────────────────────────────────────────────────
const clients = []; // {sock, userId, seen:Set}
let tokens = [];
let channelId;

async function main() {
  console.log(`ws-chat-storm: mode=${DIRECT ? "direct (cross-replica)" : "edge (nginx)"} clients=${CLIENTS} msgs=${MSGS} chaos=${CHAOS}`);
  if (CHAOS) {
    try {
      execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
    } catch {
      console.error("CHAOS=1 requires docker CLI access");
      process.exit(1);
    }
  }

  // 1. logins (paced pool — nginx auth_limit is the binding constraint)
  console.log(`[1/5] logging in ${CLIENTS} users (${LOGIN_WORKERS} workers, paced)...`);
  const t0 = now();
  tokens = new Array(CLIENTS);
  let next = 0;
  await Promise.all(
    Array.from({ length: LOGIN_WORKERS }, async () => {
      for (;;) {
        const i = next++;
        if (i >= CLIENTS) return;
        tokens[i] = await login(i);
      }
    }),
  );
  console.log(`      logins done in ${((now() - t0) / 1000).toFixed(1)}s`);

  // 2. channel: created by client 0, everyone joins over WS
  const rest = async (tok, method, path, body) => {
    try {
      const r = await fetch(`${BASE}/chat${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, json: await r.json().catch(() => null) }; // 503 pages are HTML
    } catch { return { status: 0, json: null }; }
  };
  const created = await rest(tokens[0], "POST", "/channels", { type: "channel", title: "storm", isPublic: true });
  channelId = Number(created?.json?.channel?.id);
  if (!channelId) throw new Error(`channel create failed: ${JSON.stringify(created).slice(0, 200)}`);
  console.log(`[2/5] channel ${channelId} created`);

  // REST membership first: WS channel.join only enters the room for an
  // EXISTING member. Paced under the nginx api_limit zone (10r/s) — the
  // edge stays production even in ceiling mode, so ~8 workers at 900ms
  // keep the join wave just under it; 429s retry with backoff anyway.
  const JOIN_PACE = Number(process.env.JOIN_PACE_MS || 900);
  console.log(`      REST-joining ${CLIENTS - 1} members (pace ${JOIN_PACE}ms)...`);
  let nextJoin = 1;
  const failedJoins = new Set();
  await Promise.all(
    Array.from({ length: LOGIN_WORKERS }, async () => {
      for (;;) {
        const i = nextJoin++;
        if (i >= CLIENTS) return;
        let joined = false;
        for (let a = 0; a < 14 && !joined; a++) {
          const r = await rest(tokens[i], "POST", `/channels/${channelId}/join`);
          if (r?.json?.member || r?.json?.created !== undefined) joined = true;
          else await sleep(r?.status === 429 ? 1500 : 900);
        }
        if (!joined) failedJoins.add(i);
        await sleep(JOIN_PACE);
      }
    }),
  );
  if (failedJoins.size) throw new Error(`REST membership incomplete for ${failedJoins.size} users: ${[...failedJoins].slice(0, 5)}`);
  console.log(`      membership done`);

  // 3. connect + join, ramped (starts are paced, connections run in parallel —
  // each handshake is a polling→ws upgrade worth ~2s of roundtrips)
  console.log(`[3/5] connecting ${CLIENTS} clients (ramp ${RAMP_MS}ms)...`);
  const tConn = now();
  const connecting = [];
  for (let i = 0; i < CLIENTS; i++) {
    connecting.push((async () => {
      const bucket = { sock: null, userId: i, seen: new Set(), arrived: 0, joinFailed: false };
      const s = io(targetFor(i), {
        auth: { token: tokens[i] },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });
      bucket.sock = s;
      clients[i] = bucket;
      await new Promise((res) => {
        // a socket that never completes its join is a failed bucket, not a
        // crashed run — the invariant reports it
        const timer = setTimeout(() => {
          bucket.joinFailed = true;
          res();
        }, 120000);
        const join = async () => {
          // an error ack (edge hiccup, transient rejection) retries on the
          // same socket; after 6 tries the bucket is marked and the storm
          // moves on — the invariant will fail on it instead of crashing
          for (let a = 0; a < 6; a++) {
            const r = await new Promise((res2) =>
              s.timeout(10000).emit("channel.join", { channelId }, (e, ack) => res2(e ? null : ack)),
            );
            if (r && !r.error) {
              clearTimeout(timer);
              return res();
            }
            await sleep(1000);
          }
          bucket.joinFailed = true;
          clearTimeout(timer);
          res();
        };
        s.on("connect", join);
        s.on("message.new", (m) => {
          if (Number(m.channelId) !== channelId) return;
          if (bucket.seen.has(m.id)) dupLive++;
          else {
            bucket.seen.add(m.id);
            bucket.arrived = now();
            const t = ackAt.get(m.id);
            latencies.push(t ? Math.max(0, now() - t) : -1);
          }
        });
      });
      if ((i + 1) % 50 === 0) console.log(`      ${i + 1}/${CLIENTS} joined (${((now() - tConn) / 1000).toFixed(0)}s)`);
    })());
    await sleep(RAMP_MS);
  }
  await Promise.all(connecting);
  console.log(`      all connected in ${((now() - tConn) / 1000).toFixed(1)}s`);

  // 4. flood from a single publisher (client 0) with the chaos kill in the middle
  console.log(`[4/5] flooding ${MSGS} messages from one publisher...`);
  const pub = clients[0];
  let killed = null;
  let killPlanned = false;
  const floodStart = now();
  await (async () => {
    for (let i = 1; i <= MSGS; i++) {
      if (CHAOS && !killPlanned && i > MSGS * CHAOS_AT) {
        killPlanned = true;
        killed = pickVictim();
        console.log(`      CHAOS: docker stop gateway-server-chat-server-${killed} (holder of the sockets)`);
        try {
          execFileSync("docker", ["stop", "-t", "2", `gateway-server-chat-server-${killed}`], { timeout: 30000 });
        } catch (e) { console.log(`      CHAOS: stop failed: ${e.message}`); }
      }
      const body = `storm-${i}`;
      // publisher-side outage (chaos): wait for the reconnect instead of
      // letting every queued emit burn its own 20s timeout
      if (!pub.sock?.connected) {
        await Promise.race([
          new Promise((res) => (pub.sock ? pub.sock.once("connect", res) : res())),
          sleep(30000),
        ]);
      }
      // contract-honest client: an error/timeout ack means NOT persisted —
      // retry with the SAME clientId (idempotency guarantees no duplicate);
      // a client that skips the retry loses those sends (measured 4/200
      // during a replica-kill window before this loop existed)
      for (let attempt = 0; attempt < 5; attempt++) {
        const done = await new Promise((res) => {
          pub.sock.timeout(20000).emit("message.send", { channelId, clientId: `storm-${i}`, body }, (err, ack) => {
            if (!err && ack?.id) ackAt.set(ack.id, now());
            res(!err && !!ack?.id);
          });
        });
        if (done) break;
        if (!pub.sock.connected) {
          await Promise.race([
            new Promise((res) => (pub.sock ? pub.sock.once("connect", res) : res())),
            sleep(30000),
          ]);
        }
        await sleep(500 * (attempt + 1));
      }
      await sleep(5);
    }
  })();

  // bring the killed replica back BEFORE convergence: its clients must
  // reconnect (socket.io retries land once the app listens again), receive
  // live deliveries again, and let sync fill only the true gap
  if (killed) {
    console.log(`      CHAOS: docker start gateway-server-chat-server-${killed}`);
    try { execFileSync("docker", ["start", `gateway-server-chat-server-${killed}`], { timeout: 30000 }); } catch {}
  }

  // let the fan-out settle (or hit the deadline)
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (clients.every((c) => c.seen.size >= MSGS)) { clearInterval(iv); resolve(); }
    }, 500);
    setTimeout(() => { clearInterval(iv); resolve(); }, DRAIN_SEC * 1000);
  });
  const floodWall = (now() - floodStart) / 1000;

  // 5. converge: sync gap-fill for anyone below MSGS (resume semantics);
  // a socket dropped by the chaos kill gets its reconnection + room rejoin.
  // Message ids are GLOBAL across channels — the flood occupies some
  // [base..base+MSGS-1] window, so cursors must be computed relative to
  // base (the publisher's first ack), never from 1.
  const ackIds = [...ackAt.keys()];
  const base = ackIds.length
    ? Math.min(...ackIds)
    : Math.min(...clients.flatMap((c) => (c.seen.size ? [...c.seen] : [Infinity])));
  const beforeSync = clients.filter((c) => c.seen.size >= MSGS).length;
  let synced = 0;
  for (const c of clients) {
    let guard = 0;
    while (c.seen.size < MSGS && guard++ < (MSGS / 100 + 8)) {
      if (!c.sock?.connected) {
        const back = await Promise.race([
          new Promise((res) => {
            if (!c.sock) return res(false);
            c.sock.once("connect", () => res(true));
            setTimeout(() => res(false), 60000); // replica restart + app boot fit inside
          }),
        ]);
        if (!back) break;
        await new Promise((res) => c.sock.emit("channel.join", { channelId }, () => res()));
      }
      // contiguous count from base → the highest contiguous GLOBAL id
      let cnt = 0;
      while (c.seen.has(base + cnt)) cnt++;
      const cursor = cnt ? base + cnt - 1 : 0;
      const r = await new Promise((res) =>
        c.sock.timeout(15000).emit("sync", { channels: { [channelId]: cursor } }, (e, a) => res(e ? null : a)),
      );
      const batch = (r?.messages || []).map((m) => m.id);
      if (STORM_DEBUG && batch.length)
        console.log(`      [dbg] user ${c.userId}: cursor=${cursor} got=${batch.length} ids=${batch[0]}..${batch[batch.length - 1]} typeof=${typeof batch[0]} seenSample=${[...c.seen].slice(0, 3).join(",")} truncated=${r?.truncated}`);
      if (!batch.length) break;
      batch.forEach((id) => { if (c.seen.has(id)) dupSync++; c.seen.add(id); });
      synced++;
      await sleep(10);
    }
  }

  // (its clients had already converged via sync gap-fill)

  // ── report ─────────────────────────────────────────────────────
  // console.log on a Windows pipe is asynchronous: process.exit() (even
  // deferred) can truncate it, so the report is persisted to a file first
  const lines = [];
  const out = (s) => { lines.push(s); console.log(s); };
  const received = clients.map((c) => c.seen.size);
  const okClients = clients.filter((c) => c.seen.size === MSGS).length;
  const lost = clients.reduce((s, c) => s + (MSGS - c.seen.size), 0);
  const realLat = latencies.filter((l) => l >= 0);
  out("\n════════════════════════════════════");
  out(`mode=${DIRECT ? "direct" : "edge"} clients=${CLIENTS} msgs=${MSGS} chaos=${killed ? `killed-replica-${killed}` : "no"}`);
  out(`fully_delivered_clients=${okClients}/${CLIENTS} lost_total=${lost} dup_live=${dupLive} dup_sync_recovery=${dupSync}`);
  out(`received_per_client min/med/max=${Math.min(...received)}/${pct(received, 50)}/${Math.max(...received)}`);
  out(`fanout_latency_ms p50/p95/max=${pct(realLat, 50)}/${pct(realLat, 95)}/${realLat.length ? Math.max(...realLat) : NaN} (n=${realLat.length})`);
  out(`wall_flood+drain=${floodWall.toFixed(1)}s throughput≈${(MSGS / floodWall).toFixed(0)} msg/s`);
  out(`sync_gapfill: clients_full_before=${beforeSync} sync_calls=${synced} join_failed=${clients.filter((c) => c.joinFailed).length}`);
  out(`clients=${okClients === CLIENTS && lost === 0 && dupLive === 0 ? "INVARIANT HELD (0 lost / 0 live-dup; sync recovery overlap is by design)" : "INVARIANT VIOLATED"}`);
  try { writeFileSync(new URL("./out/storm-report.json", import.meta.url), JSON.stringify({ when: new Date().toISOString(), mode: DIRECT ? "direct" : "edge", clients: CLIENTS, msgs: MSGS, killed, okClients, lost, dupLive, dupSync, syncCalls: synced, lines }, null, 2)); } catch { /* best effort */ }
  for (const c of clients) c.sock?.disconnect();
  const pass = okClients === CLIENTS && lost === 0 && dupLive === 0;
  // reffed timer: keeps the loop alive just long enough to flush stdout
  setTimeout(() => process.exit(pass ? 0 : 1), 500);
}

// pick the replica holding more sockets: /metrics from inside each container
function pickVictim() {
  const conns = (n) => {
    try {
      const out = execFileSync(
        "docker",
        ["exec", `gateway-server-chat-server-${n}`, "wget", "-qO-", "http://127.0.0.1:3004/metrics"],
        { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const m = out.match(/chat_ws_connections_total(\{[^}]*\})?\s+(\d+)/);
      return m ? Number(m[2]) : 0;
    } catch { return -1; }
  };
  const a = conns(1);
  const b = conns(2);
  console.log(`      CHAOS: connections replica1=${a} replica2=${b}`);
  return a >= b ? 1 : 2;
}

main().catch((e) => {
  console.error("storm crashed:", e);
  process.exit(1);
});
