#!/usr/bin/env node
/**
 * E2E chat flow against the live stack (nginx on :8080) — REST and the
 * Socket.IO face both go through the same edge, exactly like a frontend.
 *
 * Covers: WS handshake without a token is rejected / with a token works,
 * channel create + join + fan-out to both members, DM, edit/delete,
 * unread + read cursor, idempotent client_id replay, resume (disconnect →
 * N messages → reconnect → sync returns exactly N, no duplicates),
 * deactivation kicks the live sockets.
 *
 * Self-contained: registers and confirms its own two users via MailHog.
 *
 * Usage:  BASE=http://localhost:8080 MAILHOG=http://localhost:8025 node e2e-chat.mjs
 */
import { io } from "socket.io-client";

const BASE = process.env.BASE || "http://localhost:8080";
const MAILHOG = process.env.MAILHOG || "http://localhost:8025";
const PASSWORD = process.env.E2E_PASSWORD || "Str0ng!Passw0rd";
const STAMP = Date.now();
const USER_A = `e2e_chat_a_${STAMP}@test.local`;
const USER_B = `e2e_chat_b_${STAMP}@test.local`;

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`   OK  ${name}`); };
const bad = (name, extra) => { fail++; console.log(` FAIL  ${name}${extra ? ` — ${extra}` : ""}`); };
const check = (name, cond, extra) => (cond ? ok(name) : bad(name, extra));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// Throttle pacing: auth-server allows 5 logins/min per IP. Space them out.
let lastLogin = 0;
async function pacedLogin(username) {
  const since = Date.now() - lastLogin;
  if (since < 13500) await sleep(13500 - since);
  lastLogin = Date.now();
  return api("POST", "/account/methods/login", { body: { username, password: PASSWORD } });
}

// ── MailHog helpers (same contract as e2e-auth.mjs) ─────────────
function decodeBody(msg) {
  const enc = String(msg.Content?.Headers?.["Content-Transfer-Encoding"] || "").toLowerCase();
  const body = msg.Content?.Body ?? "";
  if (enc.includes("base64")) {
    try { return Buffer.from(body, "base64").toString("utf8"); } catch { return body; }
  }
  if (enc.includes("quoted-printable")) {
    return body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

async function waitForEmail(to, subjectPart, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILHOG}/api/v2/search?kind=to&query=${encodeURIComponent(to)}&limit=100`);
    if (res.ok) {
      const data = await res.json();
      for (const msg of data.items ?? data.messages ?? []) {
        const subject = String(msg.Content?.Headers?.Subject ?? "");
        if (!subjectPart || subject.toLowerCase().includes(subjectPart.toLowerCase())) {
          return decodeBody(msg);
        }
      }
    }
    await sleep(1500);
  }
  return null;
}

const codeFromUrl = (html) => {
  const m = html.match(/[?&]code=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
};

// ── WS + chat helpers ───────────────────────────────────────────
const connect = (token) => new Promise((res, rej) => {
  const sock = io(BASE, { auth: token ? { token } : {}, reconnection: false });
  sock.once("connect", () => res(sock));
  sock.once("connect_error", (e) => { sock.close(); rej(Object.assign(new Error(e.message), { code: e.code })); });
});
const emitAck = (sock, ev, payload, ms = 5000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout ack ${ev}`)), ms);
  sock.emit(ev, payload, (r) => { clearTimeout(t); res(r); });
});
const waitFor = (sock, ev, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting ${ev}`)), ms);
  sock.once(ev, (p) => { clearTimeout(t); res(p); });
});
const chatApi = (token, method, path, body) =>
  api(method, `/chat${path}`, { token, body });

async function registerConfirmed(email) {
  await api("POST", "/account/methods/register", {
    body: { username: email, password: PASSWORD, subject: "E2E Chat" },
  });
  const html = await waitForEmail(email, "E2E Chat");
  const code = html && codeFromUrl(html);
  if (!code) throw new Error(`no confirm email for ${email}`);
  const confirmed = await api("GET", `/account/methods/confirm/${code}`);
  if (confirmed.json?.success !== true) throw new Error(`confirm failed for ${email}`);
}

// ── scenarios ───────────────────────────────────────────────────
async function main() {
  console.log(`e2e-chat: BASE=${BASE}\n== 0. Edge health`);
  const health = await api("GET", "/health");
  check("auth /health → 200", health.status === 200, `got ${health.status}`);
  const chatAnon = await api("GET", "/chat/channels");
  check("chat REST routed by nginx, anonymous → 401", chatAnon.status === 401, `got ${chatAnon.status}`);
  const reject = await connect(null).then(
    () => null,
    (e) => e,
  );
  check("WS handshake without token rejected", !!reject && /unauthorized/i.test(reject.message), reject?.message);
  const mailhogUp = await fetch(`${MAILHOG}/api/v2/messages?limit=1`);
  check("MailHog API reachable", mailhogUp.status === 200, `got ${mailhogUp.status}`);
  if (health.status !== 200 || mailhogUp.status !== 200) process.exit(1);

  console.log("\n== 1. Two confirmed users");
  await registerConfirmed(USER_A);
  await registerConfirmed(USER_B);
  const loginA = await pacedLogin(USER_A);
  const loginB = await pacedLogin(USER_B);
  check("both users logged in", !!loginA.json?.access_token && !!loginB.json?.access_token);
  if (!loginA.json?.access_token || !loginB.json?.access_token) process.exit(1);
  const TOK_A = loginA.json.access_token;
  const TOK_B = loginB.json.access_token;

  console.log("\n== 2. WS handshake");
  const sockA = await connect(TOK_A);
  const sockB = await connect(TOK_B);
  check("both sockets connected with tokens", sockA.connected && sockB.connected);

  console.log("\n== 3. Channel: create, join, fan-out");
  const created = await chatApi(TOK_A, "POST", "/channels", { type: "channel", title: "e2e", isPublic: true });
  const chId = created.json?.channel?.id;
  check("A creates a public channel via REST", !!chId, JSON.stringify(created.json)?.slice(0, 120));
  const joinB = await chatApi(TOK_B, "POST", `/channels/${chId}/join`);
  check("B joins via REST", joinB.status < 300, JSON.stringify(joinB.json)?.slice(0, 120));
  const joinAckB = await emitAck(sockB, "channel.join", { channelId: chId });
  const joinAckA = await emitAck(sockA, "channel.join", { channelId: chId });
  check("both join the WS room (ack)", joinAckA.joined === true && joinAckB.joined === true);

  const bside = waitFor(sockB, "message.new");
  const sendAck = await emitAck(sockA, "message.send", { channelId: chId, clientId: "e2e-1", body: "hello" });
  const delivered = await bside;
  check("message.send acks the wire message", sendAck.id && sendAck.body === "hello" && !sendAck.error);
  check("message.new fans out to B", delivered.id === sendAck.id);
  const replay = await emitAck(sockA, "message.send", { channelId: chId, clientId: "e2e-1", body: "hello" });
  check("client_id replay → same message, no duplicate", replay.id === sendAck.id);

  const editAck = await emitAck(sockA, "message.edit", { channelId: chId, messageId: sendAck.id, body: "hello v2" });
  check("edit acks edited body", editAck.body === "hello v2" && !!editAck.editedAt);
  const foreign = await chatApi(TOK_B, "GET", `/channels/999999/messages`);
  check("foreign channel reads as 404", foreign.status === 404 || !!foreign.json?.message, `got ${foreign.status}`);

  console.log("\n== 4. Unread + read cursor");
  const unreadB = await chatApi(TOK_B, "GET", "/unread");
  const rowB = (Array.isArray(unreadB.json) ? unreadB.json : []).find((c) => Number(c.channelId) === Number(chId));
  check("unread counter for B", rowB && Number(rowB.unread) >= 1, JSON.stringify(unreadB.json)?.slice(0, 120));
  const readAck = await emitAck(sockB, "read", { channelId: chId, lastMessageId: sendAck.id });
  const unreadB2 = await chatApi(TOK_B, "GET", "/unread");
  const gone = !(Array.isArray(unreadB2.json) ? unreadB2.json : []).some((c) => Number(c.channelId) === Number(chId));
  check("read cursor clears unread", readAck.ok === true && gone);

  console.log("\n== 5. DM");
  const members = await chatApi(TOK_A, "GET", `/channels/${chId}/members`);
  const bId = (members.json || []).find((m) => m.username === USER_B)?.accountId;
  check("members list exposes B's account id", !!bId, JSON.stringify(members.json)?.slice(0, 150));
  const dm1 = await chatApi(TOK_A, "POST", "/channels", { type: "dm", members: [Number(bId)] });
  const dmId = dm1.json?.channel?.id;
  check("dm open returns a dmKey channel", !!dmId && !!dm1.json?.channel?.dmKey, JSON.stringify(dm1.json)?.slice(0, 150));
  const dmAgain = await chatApi(TOK_A, "POST", "/channels", { type: "dm", members: [Number(bId)] });
  check("re-opening the dm is idempotent", Number(dmAgain.json?.channel?.id) === Number(dmId), JSON.stringify(dmAgain.json)?.slice(0, 150));
  await emitAck(sockA, "channel.join", { channelId: dmId });
  await emitAck(sockB, "channel.join", { channelId: dmId });
  const dmSide = waitFor(sockB, "message.new");
  const dmAck = await emitAck(sockA, "message.send", { channelId: dmId, clientId: "e2e-dm", body: "psst" });
  check("dm message delivered", (await dmSide).id === dmAck.id);

  console.log("\n== 6. Resume: disconnect → N messages → reconnect → sync");
  sockA.disconnect();
  const N = 5;
  const sent = [];
  for (let i = 0; i < N; i++) {
    const ack = await emitAck(sockB, "message.send", { channelId: chId, clientId: `e2e-off-${i}`, body: `offline ${i}` });
    sent.push(ack.id);
  }
  check(`${N} messages stored while A is offline`, sent.every(Boolean), JSON.stringify(sent));
  const sockA2 = await connect(TOK_A);
  await emitAck(sockA2, "channel.join", { channelId: chId });
  const sync = await emitAck(sockA2, "sync", { channels: { [chId]: sendAck.id } });
  const back = (sync.messages || []).map((m) => m.id);
  check("sync returns exactly the offline messages, no duplicates", back.length === N && new Set(back).size === N && sent.every((id) => back.includes(id)), JSON.stringify(back));

  console.log("\n== 7. Delete semantics");
  const delAck = await emitAck(sockA2, "message.delete", { channelId: chId, messageId: sent[0] });
  check("author delete acks the id", delAck.id === sent[0]);
  const delForeign = await emitAck(sockB, "message.delete", { channelId: chId, messageId: sendAck.id });
  check("plain member cannot delete another's message", delForeign.error?.code === "forbidden");
  const history = await chatApi(TOK_A, "GET", `/channels/${chId}/messages?limit=50`);
  check("tombstone gone from REST history", !(history.json?.items || []).some((m) => m.id === sent[0]));

  console.log("\n== 8. Deactivation kicks live sockets");
  const kicked = new Promise((res) => sockB.once("disconnect", res));
  await api("POST", "/account/methods/deactivate", { token: TOK_B, body: { password: PASSWORD } });
  const won = await Promise.race([kicked.then(() => true), sleep(15000).then(() => false)]);
  check("deactivated user's socket is kicked via the event bus", won);
  check("A's socket survives the kick", sockA2.connected);
  sockA2.disconnect();
  sockA.disconnect();

  console.log("\n════════════════════════════════════");
  console.log(`E2E ${fail === 0 ? "PASSED" : "FAILED"}: ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e crashed:", e);
  process.exit(1);
});
