import http from "k6/http";
import { sleep } from "k6";

// ═══════════════════════════════════════════════════════════════
// File upload/download workload: JWT login once per VU, then a
// ~64 KB multipart POST /files/upload + GET of the returned URL.
// Storage-agnostic: the same numbers are comparable across
// FILE_STORAGE=local and FILE_STORAGE=s3 runs (results.md).
//
//   k6 run -e AUTH_URL=http://nginx -e FILES_URL=http://nginx \
//     -e VUS=10 -e DURATION=30s files-upload.js
// ═══════════════════════════════════════════════════════════════

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || "30s",
};

const PAYLOAD = new Array(64 * 1024)
  .fill(0)
  .map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26)))
  .join("");

export function setup() {
  const res = http.post(
    `${__ENV.AUTH_URL || "http://nginx"}/account/methods/login`,
    JSON.stringify({
      username: "load_0@test.local",
      password: "LoadPass123!",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
  const token = res.json("access_token");
  if (!token) {
    throw new Error(`login failed: ${res.status} ${res.body.slice(0, 120)}`);
  }
  return { token };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` };
  const up = http.post(
    `${__ENV.FILES_URL || "http://nginx"}/files/upload`,
    {
      file: http.file(PAYLOAD, "load.bin", "application/octet-stream"),
      folder: "filesload",
    },
    { headers },
  );

  if (up.status === 200 || up.status === 201) {
    const url = up.json("0.url") || up.json("url");
    if (url) {
      http.get(`${__ENV.FILES_URL || "http://nginx"}${url}`, { headers });
    }
  }
  sleep(0.2);
}
