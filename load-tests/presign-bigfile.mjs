// Deferred Wave 6 / Stage 4 scenario: 100MB+ presigned PUT → presigned GET.
//
// Presigned traffic bypasses file-server and nginx entirely (client → bucket
// direct); this measures that path, which files-upload.js never touches.
// Requires the stack booted with docker-compose.s3.yml (FILE_STORAGE=s3,
// S3_PRESIGN_ENDPOINT=http://127.0.0.1:9000 published on the host).
//
// Usage (from gateway-server/):
//   node load-tests/presign-bigfile.mjs [sizeMB]
// Env: BASE (default http://localhost:8080), USER_NAME/USER_PASS of an
// existing seed user (defaults match load-tests/seed-load.sql).
import { createHash, randomFillSync, randomUUID } from "node:crypto";
import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:8080";
const MB = Number(process.argv[2] || 100);
const USER = process.env.USER_NAME || "load_0@test.local";
const PASS = process.env.USER_PASS || "LoadPass123!";
const TMP = `presign-${randomUUID()}.bin`;

const j = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };
const ms = (t) => `${((Date.now() - t) / 1000).toFixed(2)}s`;

// 1. login → JWT (single attempt — no flood; seed users are bcrypt cost 10)
const login = await fetch(`${BASE}/account/methods/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const loginBody = await j(login);
if (!login.ok) { console.error("FAIL login:", login.status, loginBody); process.exit(1); }
const jwt = loginBody.accessToken || loginBody.access_token;
if (!jwt) { console.error("FAIL no token in login response:", Object.keys(loginBody)); process.exit(1); }
console.log(`OK   login ${USER}`);

// 2. presign upload (server generates the key — the client never picks it)
const up = await j(await fetch(`${BASE}/files/presign/upload`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ filename: `big-${MB}mb.bin`, folder: "loadtest" }),
}));
if (!up.url) { console.error("FAIL presign/upload:", up); process.exit(1); }
console.log(`OK   presign/upload key=${up.key} expiresIn=${up.expiresIn}s url=${up.url.split("?")[0]}`);

// 3. payload on disk (urandom — no compressible zeros). writeSync may write
// less than requested — loop until the chunk is fully on disk, then hash the
// DISK contents (ground truth, not the in-memory buffer) for both legs.
let t = Date.now();
const fd = openSync(TMP, "w");
const buf = Buffer.alloc(4 * 1024 * 1024);
let left = MB * 1024 * 1024;
while (left > 0) {
  const n = Math.min(left, buf.length);
  randomFillSync(buf);
  let off = 0;
  while (off < n) off += writeSync(fd, buf, off, n - off);
  left -= n;
}
closeSync(fd);
const hasher = createHash("sha256");
const md5er = createHash("md5");
const rs = readFileSync(TMP);
for (let o = 0; o < rs.length; o += buf.length) {
  hasher.update(rs.subarray(o, Math.min(o + buf.length, rs.length)));
  md5er.update(rs.subarray(o, Math.min(o + buf.length, rs.length)));
}
const digest = hasher.digest("hex");
const payloadMd5 = md5er.digest("hex");
if (rs.length !== MB * 1024 * 1024) {
  console.error(`FAIL payload size on disk ${rs.length} != ${MB}MB`);
  process.exit(1);
}
console.log(`OK   payload ${MB}MB built in ${ms(t)} sha256=${digest.slice(0, 16)}…`);

// 4. presigned PUT straight to the bucket (no file-server, no nginx in path)
t = Date.now();
const put = await fetch(up.url, { method: "PUT", body: readFileSync(TMP) });
const putText = await put.text();
if (!put.ok) { console.error("FAIL PUT:", put.status, putText.slice(0, 300)); process.exit(1); }
const etag = (put.headers.get("etag") || "").replaceAll('"', "");
console.log(`OK   PUT ${MB}MB in ${ms(t)} → ${(MB / ((Date.now() - t) / 1000)).toFixed(0)} MB/s (status ${put.status}, etag ${etag})`);
const putLegOk = etag === payloadMd5;
console.log(`     PUT integrity: etag ${putLegOk ? "==" : "!="} payload md5 → upload leg ${putLegOk ? "clean" : "CORRUPT"}`);

// 5. presign download → GET → byte-identical round-trip
const down = await j(await fetch(`${BASE}/files/presign/download`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ key: up.key }),
}));
if (!down.url) { console.error("FAIL presign/download:", down); process.exit(1); }
t = Date.now();
const get = await fetch(down.url);
if (!get.ok) { console.error("FAIL GET:", get.status, (await get.text()).slice(0, 300)); process.exit(1); }
const body = Buffer.from(await get.arrayBuffer());
const getDigest = createHash("sha256").update(body).digest("hex");
const getLen = body.length;
const disposition = get.headers.get("content-disposition") || "(none)";
console.log(`OK   GET ${MB}MB in ${ms(t)} → ${(MB / ((Date.now() - t) / 1000)).toFixed(0)} MB/s (${getLen} bytes)`);
const getLegOk = getDigest === digest && getLen === MB * 1024 * 1024;
console.log(`     round-trip sha256 ${getLegOk ? "MATCHES" : `MISMATCH (got ${getDigest.slice(0, 16)}…, ${getLen} bytes)`}, content-disposition: ${disposition}`);

unlinkSync(TMP);
if (!putLegOk || !getLegOk) {
  console.error(`\nFAIL presigned ${MB}MB round-trip: upload leg ${putLegOk ? "clean" : "CORRUPT"}, download leg ${getLegOk ? "clean" : "CORRUPT"}`);
  process.exit(1);
}
console.log(`\nPASS presigned ${MB}MB PUT+GET round-trip`);
