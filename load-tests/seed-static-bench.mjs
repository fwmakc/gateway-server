#!/usr/bin/env node
/**
 * Seeder for the static-serving benchmark: registers a throwaway admin on
 * the LIVE stack, publishes the `site-assets` folder rule (visibility
 * public) and uploads the k6 payload files (icon.png 1.5 KB, article.png
 * 200 KB, big.jpg 1 MB — from out/staticbench/). Same account pattern as
 * e2e-cases.mjs (confirm code read from the auth DB) — dev/load envs only.
 *
 * Usage: node seed-static-bench.mjs   (BASE defaults to :8080)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE || "http://localhost:8080";
const PASSWORD = "Str0ng!Passw0rd";
const EMAIL = `bench_${Date.now()}@test.local`;
const GW_DIR = fileURLToPath(new URL("./", import.meta.url)); // gateway-server/
const PAYLOADS_URL = new URL("./out/staticbench/", import.meta.url);

const PSQL = ["compose", "exec", "-T", "postgres", "psql", "-U", "root"];
const sql = (q) =>
  execFileSync("docker", [...PSQL, "-d", "auth_server", "-t", "-Ac", q], {
    encoding: "utf8",
    cwd: GW_DIR,
  }).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function throttled(fn) {
  for (let i = 1; i <= 8; i++) {
    const res = await fn();
    if (res.status !== 429) return res;
    console.log(`   429 throttled, waiting 25s [${i}/8]`);
    await sleep(25000);
  }
  throw new Error("still throttled");
}

const api = async (method, path, opts = {}) => {
  const res = await fetch(BASE + path, { method, ...opts, redirect: "manual" });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// 1. register + confirm + login (admin role seeded before re-login so the JWT carries it)
const reg = await throttled(() =>
  api("POST", "/account/methods/register", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: EMAIL, password: PASSWORD }),
  }),
);
if (reg.status >= 400) throw new Error(`register ${reg.status}`);
const id = sql(`SELECT id FROM accounts WHERE username='${EMAIL}'`);
const code = sql(
  `SELECT code FROM account_confirm WHERE account_id=${id} AND type='code' ORDER BY id DESC LIMIT 1`,
);
console.log(`registered id=${id} code=${code}`);
const conf = await api("GET", `/account/methods/confirm/${code}`);
if (!conf.json?.success) throw new Error(`confirm ${conf.status}`);

sql(`INSERT INTO roles (name) VALUES ('admin') ON CONFLICT (name) DO NOTHING`);
sql(
  `INSERT INTO account_roles (account_id, role_id) SELECT ${id}, id FROM roles WHERE name='admin' ON CONFLICT DO NOTHING`,
);
const login = await throttled(() =>
  api("POST", "/account/methods/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: EMAIL, password: PASSWORD }),
  }),
);
const token = login.json?.access_token;
if (!token) throw new Error(`login ${login.status}`);
console.log("admin token acquired");

// 2. public folder rule
const acl = await api("POST", "/files/acl", {
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: "site-assets", pathType: "folder", visibility: "public" }),
});
console.log(`acl site-assets → ${acl.status}`);
if (acl.status >= 300) throw new Error(JSON.stringify(acl.json));

// 3. upload payloads
for (const name of ["icon.png", "article.png", "big.jpg"]) {
  const buf = readFileSync(new URL(name, PAYLOADS_URL));
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buf], { type: name.endsWith(".jpg") ? "image/jpeg" : "image/png" }),
    name,
  );
  const res = await fetch(
    `${BASE}/files/upload?options=${encodeURIComponent(JSON.stringify({ folder: "site-assets" }))}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd },
  );
  const json = await res.json().catch(() => null);
  console.log(`upload ${name} → ${res.status} ${json?.[0]?.url ?? res.statusText}`);
  if (res.status >= 300) throw new Error(JSON.stringify(json));
}

// 4. anonymous sanity: 200 + public cache headers
for (const name of ["icon.png", "article.png", "big.jpg"]) {
  const res = await fetch(`${BASE}/uploads/site-assets/${name}`);
  console.log(
    `anon GET ${name} → ${res.status} cache-control=${res.headers.get("cache-control")}`,
  );
}
console.log("throwaway admin: " + EMAIL);
