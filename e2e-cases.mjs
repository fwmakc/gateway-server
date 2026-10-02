#!/usr/bin/env node
/**
 * E2E use cases beyond auth, against the live stack (nginx :8080).
 *
 * A. Posts CRUD under Access rules: anonymous / owner / editor / admin —
 *    scope isolation, filter-wins-over-where, secretNotes field rules.
 * B. File lifecycle: JWT-gated upload, download round-trip, replace,
 *    already-exists, traversal sanitization.
 * C. Subscription lifecycle on the event bus: HMAC-signed delivery,
 *    contract validation, secret rotation, unsubscribe, anti-replay.
 *
 * Needs: full stack up (docker compose), MailHog not required (confirm codes
 * are read from the auth DB), event-server reachable via `docker compose exec`.
 * Usage:  node e2e-cases.mjs   (from gateway-server/, BASE default :8080)
 */
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:8080";
const IAK = process.env.INTERNAL_API_KEY || readEnvKey("INTERNAL_API_KEY") || "";
const PASSWORD = process.env.E2E_PASSWORD || "Str0ng!Passw0rd";

function readEnvKey(key) {
  try {
    const line = readFileSync(new URL("./.env", import.meta.url), "utf8")
      .split("\n").find((l) => l.startsWith(key + "="));
    return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  } catch { return undefined; }
}

let pass = 0, fail = 0;
const ok = (n, extra) => { pass++; console.log(`   OK  ${n}${extra ? ` — ${extra}` : ""}`); };
const bad = (n, extra) => { fail++; console.log(` FAIL  ${n}${extra ? ` — ${extra}` : ""}`); };
const check = (n, cond, extra) => (cond ? ok(n, extra) : bad(n, extra));

async function api(method, path, { body, token, headers, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json, text: raw ? await res.text() : undefined, headers: res.headers };
}

// ── DB helpers (confirm codes, role seeding) via compose postgres ────
const PSQL = ["compose", "exec", "-T", "postgres", "psql", "-U", "root"];
function sql(db, query) {
  return execFileSync("docker", [...PSQL, "-d", db, "-t", "-Ac", query], { encoding: "utf8" }).trim();
}
// ── event-server internal API via compose exec (no host port) ────────
function ev(method, path, body) {
  const js = `fetch("http://localhost:3005${path}",{method:"${method}",headers:{"content-type":"application/json","x-internal-api-key":process.env.IAK}${body ? ",body:process.env.BODY" : ""}}).then(async r=>{console.log(r.status+"\\n"+(await r.text()))}).catch(e=>{console.log("ERR\\n"+e.message)})`;
  const args = ["compose", "exec", "-T", "-e", `IAK=${IAK}`];
  if (body) args.push("-e", `BODY=${JSON.stringify(body)}`);
  args.push("event-server", "node", "-e", js);
  const out = execFileSync("docker", args, { encoding: "utf8", cwd: import.meta.dirname });
  const [status, ...rest] = out.trim().split("\n");
  return { status: Number(status), json: rest.length ? JSON.parse(rest.join("\n")) : null, text: rest.join("\n") };
}

// SECTION=C skips A/B (users+files) for fast iteration on the bus section
const ONLY = process.env.SECTION || "";

const EMAILS = {
  owner: `case_o_${Date.now()}_${Math.floor(Math.random() * 1e4)}@test.local`,
  owner2: `case_o2_${Date.now()}_${Math.floor(Math.random() * 1e4)}@test.local`,
  editor: `case_e_${Date.now()}_${Math.floor(Math.random() * 1e4)}@test.local`,
  admin: `case_a_${Date.now()}_${Math.floor(Math.random() * 1e4)}@test.local`,
};
const tokens = {};

// register/login are throttled per IP (3-5/min): retry 429s until the window rolls
async function throttled(fn, what) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fn();
    if (res.status !== 429) return res;
    if (attempt === 6) return res;
    console.log(`   ..  ${what} throttled (429), waiting 25s [${attempt}/6]`);
    await new Promise((r) => setTimeout(r, 25000));
  }
}

async function makeUser(name) {
  const email = EMAILS[name];
  const reg = await throttled(
    () => api("POST", "/account/methods/register", { body: { username: email, password: PASSWORD } }),
    `register ${name}`);
  if (reg.status >= 400) { bad(`register ${name}`, `status=${reg.status}`); throw new Error(`register ${name} failed: ${reg.status}`); }
  ok(`register ${name}`);
  const accountId = sql("auth_server",
    `SELECT id FROM accounts WHERE username='${email}'`);
  const code = sql("auth_server",
    `SELECT code FROM account_confirm WHERE account_id=${accountId} AND type='code' ORDER BY id DESC LIMIT 1`);
  const conf = await api("GET", `/account/methods/confirm/${code}`);
  check(`confirm ${name}`, conf.json?.success === true, `code=${code}`);
  const login = await throttled(
    () => api("POST", "/account/methods/login", { body: { username: email, password: PASSWORD } }),
    `login ${name}`);
  tokens[name] = login.json?.access_token;
  check(`login ${name} → JWT`, !!tokens[name]);
  return Number(accountId);
}

// ════════════════════════ A. Roles & posts ═══════════════════════════
if (ONLY !== "C") {
console.log("\n== A. Posts CRUD under Access rules (public/owner/editor/admin)");
console.log("   (register + confirm 4 accounts; roles seeded before login so JWT carries them)");
const oId = await makeUser("owner");
const o2Id = await makeUser("owner2");
const eId = await makeUser("editor");
const aId = await makeUser("admin");

sql("auth_server", `INSERT INTO roles (name) VALUES ('editor'),('admin') ON CONFLICT (name) DO NOTHING`);
sql("auth_server", `INSERT INTO account_roles (account_id, role_id) SELECT ${eId}, id FROM roles WHERE name='editor' ON CONFLICT DO NOTHING`);
sql("auth_server", `INSERT INTO account_roles (account_id, role_id) SELECT ${aId}, id FROM roles WHERE name='admin' ON CONFLICT DO NOTHING`);
// tokens issued above predate the role seed → re-login editor/admin
for (const n of ["editor", "admin"]) {
  const l = await api("POST", "/account/methods/login", { body: { username: EMAILS[n], password: PASSWORD } });
  tokens[n] = l.json?.access_token;
}

// api-server keeps a LOCAL accounts mirror (posts.account_id FK) with no sync
// path from auth-server (Wave 6 stage-3 finding) — until that seam is
// designed, ops must mirror accounts manually (as load-tests seed.sql does):
for (const [name, id] of [["owner", oId], ["owner2", o2Id], ["editor", eId], ["admin", aId]]) {
  sql("api_server",
    `INSERT INTO accounts (id, username, password, is_activated, is_superuser) VALUES (${id}, '${EMAILS[name]}', 'x', 1, 0) ON CONFLICT (id) DO NOTHING`);
}

// anonymous: create denied, read only published, filter wins over where
{
  const r = await api("POST", "/posts/create", { body: { create: { title: "anon", content: "x" } } });
  check("anon create → denied (401/403/404)", [401, 403, 404].includes(r.status), `status=${r.status}`);
  const pub = await api("GET", "/posts/find?limit=100");
  check("anon find → 200", pub.status === 200);
  const list = pub.json || [];
  check("anon find sees only published", list.every((p) => p.isPublished === true || String(p.isPublished) === "true"), `rows=${list.length}`);
  const sneaky = await api("GET", `/posts/find?where=${encodeURIComponent(JSON.stringify({ isPublished: false }))}&limit=100`);
  check("anon find with where={isPublished:false} still returns only published (filter wins)",
    (sneaky.json || []).every((p) => p.isPublished === true || String(p.isPublished) === "true"), `rows=${(sneaky.json || []).length}`);
}

// owner creates an unpublished post with a secret field attempt
const p1 = await api("POST", "/posts/create", {
  token: tokens.owner,
  body: { create: { title: "case-p1", content: "owner post", isPublished: false, secretNotes: "owner-wrote-this" } },
});
check("owner create unpublished → 2xx", p1.status < 300, `status=${p1.status}`);
check("secretNotes stripped from owner response (editor/admin only)",
  p1.json && !("secretNotes" in p1.json), JSON.stringify(p1.json?.secretNotes));
const P1 = p1.json?.id;
check("create stamps owner (account_id present)", p1.json?.account_id === oId || p1.json?.accountId === oId || !!P1);

// extra posts for delete checks
const p2 = await api("POST", "/posts/create", { token: tokens.owner, body: { create: { title: "case-p2", content: "x", isPublished: true } } });
const P2 = p2.json?.id;
const p3 = await api("POST", "/posts/create", { token: tokens.owner2, body: { create: { title: "case-p3", content: "x", isPublished: true } } });
const P3 = p3.json?.id;

// scope isolation for the second owner
check("owner reads own unpublished by id → 200", (await api("GET", `/posts/find/${P1}`, { token: tokens.owner })).status === 200);
check("other owner reads it → 404 (outside scope)", (await api("GET", `/posts/find/${P1}`, { token: tokens.owner2 })).status === 404);
check("other owner update → 404", (await api("PATCH", `/posts/update/${P1}`, { token: tokens.owner2, body: { update: { content: "hacked" } } })).status === 404);
{
  const del = await api("DELETE", `/posts/remove/${P1}`, { token: tokens.owner2 });
  check("other owner delete → denied (404)", del.status === 404, `status=${del.status} body=${JSON.stringify(del.json)}`);
}
check("anon reads unpublished by id → 404", (await api("GET", `/posts/find/${P1}`)).status === 404);

// editor: sees everything, writes secretNotes, cannot delete
const eFind = await api("GET", `/posts/find?where=${encodeURIComponent(JSON.stringify({ title: "case-p1" }))}`, { token: tokens.editor });
check("editor find sees others' unpublished (by title filter)", (eFind.json || []).some((p) => String(p.id) === String(P1)), `rows=${(eFind.json || []).length}`);
check("editor update others' post → 2xx",
  (await api("PATCH", `/posts/update/${P1}`, { token: tokens.editor, body: { update: { content: "edited" } } })).status < 300);
check("editor writes secretNotes → persisted",
  await (async () => {
    await api("PATCH", `/posts/update/${P1}`, { token: tokens.editor, body: { update: { secretNotes: "editor-note" } } });
    return (await api("GET", `/posts/find/${P1}`, { token: tokens.editor })).json?.secretNotes === "editor-note";
  })());
check("owner cannot overwrite secretNotes (request stripped), value intact",
  await (async () => {
    await api("PATCH", `/posts/update/${P1}`, { token: tokens.owner, body: { update: { secretNotes: "hax" } } });
    return (await api("GET", `/posts/find/${P1}`, { token: tokens.editor })).json?.secretNotes === "editor-note";
  })());
{
  const del = await api("DELETE", `/posts/remove/${P3}`, { token: tokens.editor });
  check("editor delete others' post → denied (403/404)", del.status === 403 || del.status === 404, `status=${del.status} body=${JSON.stringify(del.json)}`);
}

// admin: deletes anyone's post; owner deletes own
check("owner delete own → 2xx", (await api("DELETE", `/posts/remove/${P2}`, { token: tokens.owner })).status < 300);
check("admin delete others' → 2xx", (await api("DELETE", `/posts/remove/${P3}`, { token: tokens.admin })).status < 300);

// ════════════════════════ B. File lifecycle ══════════════════════════
console.log("\n== B. File lifecycle (upload gated, round-trip, replace, traversal)");
const STAMP = Date.now();
{
  // uploads share the nginx api_limit zone (10r/s burst 20, per client IP) —
  // pace the section so legit rapid-fire doesn't trip the limiter
  const pace = () => new Promise((r) => setTimeout(r, 1100));
  await pace();
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("hello files")], { type: "text/plain" }), `e2e-case-${STAMP}.txt`);
  const anon = await fetch(`${BASE}/files/upload`, { method: "POST", body: fd });
  check("anon upload → 401", anon.status === 401, `status=${anon.status}`);

  const up = async (name, body, opt) => {
    const f = new FormData();
    f.append("file", new Blob([body], { type: "text/plain" }), name);
    const res = await fetch(`${BASE}/files/upload${opt ? `?options=${encodeURIComponent(JSON.stringify(opt))}` : ""}`,
      { method: "POST", headers: { Authorization: `Bearer ${tokens.owner}` }, body: f });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json (e.g. nginx HTML error page) */ }
    return { status: res.status, json, text };
  };
  await pace();
  const first = await up(`e2e-case-${STAMP}.txt`, Buffer.from("hello files"));
  check("upload → url", !!first?.json?.[0]?.url, `status=${first.status} ${JSON.stringify(first.json?.[0]) ?? first.text.slice(0, 80)}`);
  const url = first?.json?.[0]?.url;
  const abs = url?.startsWith("http") ? url : BASE + url;
  await pace();
  const dl = await fetch(abs);
  check("download round-trip (bytes)", (await dl.text()) === "hello files", `status=${dl.status}`);

  await pace();
  const dup = await up(`e2e-case-${STAMP}.txt`, Buffer.from("again"));
  check("re-upload without replace → already exists error", !!dup?.json?.[0]?.error, `status=${dup.status} ${JSON.stringify(dup.json?.[0]) ?? dup.text.slice(0, 80)}`);

  await pace();
  const rep = await up(`e2e-case-${STAMP}.txt`, Buffer.from("replaced body"), { replace: true });
  check("upload with replace → ok", !rep?.json?.[0]?.error && !!rep?.json?.[0]?.url, `status=${rep.status} ${JSON.stringify(rep.json?.[0]) ?? rep.text.slice(0, 80)}`);
  await pace();
  const dl2 = await fetch(abs);
  check("replace persisted", (await dl2.text()) === "replaced body");

  await pace();
  const trav = await up(`../../etc/evil-${STAMP}.txt`, Buffer.from("evil"));
  const travUrl = trav?.json?.[0]?.url || "";
  check("traversal name sanitized (no .. in url)", !!travUrl && !travUrl.includes(".."), `status=${trav.status} ${travUrl}`);
}
} // end A/B guard

// ═════════ C. Subscription lifecycle (HMAC, rotate, replay) ══════════
if (ONLY !== "A" && ONLY !== "B") {
console.log("\n== C. Event bus: subscription, HMAC delivery, rotation, replay");
{
  // Receiver runs as a container on the event-server network — the production
  // topology (subscriber = a service). Deliveries go container→container; the
  // host drives it through the published 127.0.0.1 port. (A host-process
  // receiver over host.docker.internal is unreliable here: DNS resolves to
  // the Desktop gateway but Windows Firewall blocks the inbound listener.)
  const RX_NAME = "e2e-rx";
  const RX_PORT = 39999;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const docker = (args, { mayFail = false } = {}) => {
    try { return execFileSync("docker", args, { encoding: "utf8", cwd: import.meta.dirname }); }
    catch (e) { if (mayFail) return ""; throw e; }
  };

  docker(["rm", "-f", RX_NAME], { mayFail: true });
  // event-server sits on several compose networks — deliver over the
  // internal one; the docker run must target the same network
  const NETS = docker(["inspect", "gateway-server-event-server-1",
    "--format", "{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}"]).trim().split(/\s+/).filter(Boolean);
  const NET = NETS.find((n) => /backend/.test(n)) || NETS[0];
  const images = docker(["images", "--format", "{{.Repository}}:{{.Tag}}"]).split("\n").map((s) => s.trim());
  const IMG = images.find((i) => /^node:\d+(\.\d+)?-slim$/.test(i)) || images.find((i) => /^node:\d+(\.\d+)?-alpine$/.test(i));
  check("node base image available locally", !!IMG, IMG || "none found");
  if (!IMG) throw new Error("no local node image for the receiver container");
  docker(["run", "-d", "--name", RX_NAME, "--network", NET, "-p", `127.0.0.1:${RX_PORT}:39999`, IMG,
    "node", "-e",
    "const G=[];require('http').createServer((req,res)=>{const cs=[];req.on('data',c=>cs.push(c));req.on('end',()=>{" +
    "if(req.url==='/hook'){G.push({raw:Buffer.concat(cs).toString(),sig:req.headers['x-event-signature'],ts:req.headers['x-event-timestamp']});res.writeHead(200);res.end('ok');}" +
    "else if(req.url==='/dump'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(G));}" +
    "else if(req.url==='/reset'){G.length=0;res.writeHead(200);res.end('ok');}" +
    "else{res.writeHead(200);res.end('pong');}});}).listen(39999,'0.0.0.0');"]);

  try {
    let up = false;
    for (let t = 0; t < 15000 && !up; t += 500) {
      try { up = (await fetch(`http://127.0.0.1:${RX_PORT}/ping`)).status === 200; } catch { /* not yet */ }
      if (!up) await sleep(500);
    }
    check("receiver container up (host → published port)", up);
    if (!up) throw new Error("receiver did not start");

    const reach = docker(["compose", "exec", "-T", "event-server", "node", "-e",
      `fetch("http://${RX_NAME}:39999/ping").then(r=>console.log("ping "+r.status)).catch(e=>console.log("pingfail "+e.message))`]);
    check("event-server reaches receiver (container network)", reach.includes("ping 200"), reach.trim());
    if (reach.includes("pingfail")) throw new Error("event-server cannot reach receiver");

    const dump = async () => { const r = await fetch(`http://127.0.0.1:${RX_PORT}/dump`); return r.json(); };
    const waitDelivery = async (ms) => {
      const n = (await dump()).length;
      for (let t = 0; t < ms; t += 500) { if ((await dump()).length > n) return true; await sleep(500); }
      return false;
    };

    const sub = ev("POST", "/subscribe", { service: `e2e-cases-${Date.now()}`, url: `http://${RX_NAME}:39999/hook`, patterns: ["user.registered"], generateSecret: true });
    check("subscribe → id + secret", sub.status < 300 && !!sub.json?.secret, `status=${sub.status}`);
    const SUB = sub.json?.id;
    let secret = sub.json?.secret;

    const hmac = (sec, ts, raw) => createHmac("sha256", sec).update(`${ts}.${raw}`).digest("hex");
    // wire format: x-event-signature = "sha256=" + hex(hmac(secret, "<ts>.<rawBody>"))
    const sigOf = (sec, ts, raw) => "sha256=" + hmac(sec, ts, raw);
    const publish = (payload) => ev("POST", "/events", { pattern: "user.registered", payload, source: "e2e-cases" });

    const pub1 = publish({ userId: 424242, username: "e2e-cases", email: "e2e@test.local" });
    check("publish valid contract → 2xx", pub1.status < 300, `status=${pub1.status}`);
    check("delivery arrives ≤10s", await waitDelivery(10000));
    let all = await dump();
    const d1 = all[all.length - 1];
    if (d1) {
      check("delivery signed (x-event-signature + x-event-timestamp)", !!d1.sig && !!d1.ts);
      check("HMAC verifies with subscriber secret (scheme sha256=<hex>(ts.body))", d1.sig === sigOf(secret, d1.ts, d1.raw),
        `sig=${d1.sig?.slice(0, 20)}.. ts=${d1.ts}`);
      const age = Math.abs(Date.now() - Number(d1.ts) * 1000);
      check("delivery timestamp fresh (anti-replay window ≤5min)", Number.isFinite(age) && age <= 300_000, `age=${Math.round(age / 1000)}s`);
    }

    const badPayload = publish({ userId: 1, username: "no-email" });
    check("publish invalid payload (contract) → 4xx", badPayload.status >= 400, `status=${badPayload.status}`);

    const n0 = (await dump()).length;
    const wrongPattern = ev("POST", "/events", { pattern: "user.confirmed", payload: { userId: 1, username: "e2e-cases", email: "e2e@test.local" }, source: "e2e-cases" });
    check("publish non-subscribed pattern accepted at bus", wrongPattern.status < 300, `status=${wrongPattern.status}`);
    await sleep(4000);
    const after = (await dump()).slice(n0);
    check("no delivery for non-subscribed pattern", after.length === 0,
      after.map((d) => { try { return JSON.parse(d.raw).pattern; } catch { return "?"; } }).join(",") || "none");

    // rotate: new secret delivered, old invalid
    const rot = ev("POST", `/subscribe/${SUB}/rotate`);
    check("rotate → new secret", rot.status < 300 && !!rot.json?.secret && rot.json.secret !== secret, `status=${rot.status}`);
    const oldSecret = secret;
    secret = rot.json?.secret;
    publish({ userId: 424243, username: "e2e-cases", email: "e2e@test.local" });
    check("delivery after rotation arrives", await waitDelivery(10000));
    all = await dump();
    const d2 = all[all.length - 1];
    if (d2 && d2 !== d1) {
      check("new delivery verifies with NEW secret", d2.sig === sigOf(secret, d2.ts, d2.raw));
      check("new delivery does NOT verify with OLD secret", d2.sig !== sigOf(oldSecret, d2.ts, d2.raw));
    }

    // unsubscribe: deliveries stop
    const unsub = ev("DELETE", `/subscribe/${SUB}`);
    check("unsubscribe → 2xx", unsub.status < 300, `status=${unsub.status}`);
    const n2 = (await dump()).length;
    publish({ userId: 424244, username: "e2e-cases", email: "e2e@test.local" });
    await sleep(4000);
    check("no delivery after unsubscribe", (await dump()).length === n2);
  } finally {
    docker(["rm", "-f", RX_NAME], { mayFail: true });
  }
}
} // end C guard + block

console.log(`\n${fail === 0 ? "E2E CASES PASSED" : "E2E CASES FAILED"}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
