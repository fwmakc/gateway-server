#!/usr/bin/env node
/**
 * E2E auth flow against the live stack (nginx on :8080, MailHog on :8025).
 *
 * Covers: registration → confirmation via the emailed link, login, JWT,
 * refresh-token rotation + reuse detection, logout, password reset via
 * email, 2FA (TOTP and email code), deactivation.
 *
 * Usage:  BASE=http://localhost:8080 MAILHOG=http://localhost:8025 node e2e-auth.mjs
 * The stack must run with TWO_FACTOR_ENABLED=true and the mailhog override.
 */
import { createHmac } from "node:crypto";

const BASE = process.env.BASE || "http://localhost:8080";
const MAILHOG = process.env.MAILHOG || "http://localhost:8025";
const PASSWORD = process.env.E2E_PASSWORD || "Str0ng!Passw0rd";
const PASSWORD2 = PASSWORD + "x";
const EMAIL = `e2e_${Date.now()}_${Math.floor(Math.random() * 1e5)}@test.local`;

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
    redirect: "manual",
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json, headers: res.headers };
}

// Throttle pacing: auth-server allows 5 logins/min per IP. Space them out.
let lastLogin = 0;
async function pacedLogin(body) {
  const since = Date.now() - lastLogin;
  if (since < 13500) await sleep(13500 - since);
  lastLogin = Date.now();
  return api("POST", "/account/methods/login", { body });
}

// ── MailHog helpers ─────────────────────────────────────────────
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
      // MailHog v2 returns `items` (v1 returned `messages`).
      for (const msg of data.items ?? data.messages ?? []) {
        const subject = String(msg.Content?.Headers?.Subject ?? "");
        if (!subjectPart || subject.toLowerCase().includes(subjectPart.toLowerCase())) {
          return { subject, html: decodeBody(msg) };
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
const sixDigits = (html) => {
  const m = html.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
};

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30s — matches otplib defaults) ──
function base32Decode(s) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const idx = alpha.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret) {
  const counter = Math.floor(Date.now() / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const num = (((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]) % 1e6;
  return String(num).padStart(6, "0");
}
function secretFromOtpauth(otpauth) {
  return decodeURIComponent((otpauth.match(/[?&]secret=([^&]+)/) || [])[1] || "");
}

// ── scenarios ───────────────────────────────────────────────────
async function main() {
  console.log(`e2e-auth: BASE=${BASE} MAILHOG=${MAILHOG}\n== 0. Health`);
  const health = await api("GET", "/health");
  check("auth /health → 200", health.status === 200, `got ${health.status}`);
  const mailhogUp = await fetch(`${MAILHOG}/api/v2/messages?limit=1`);
  check("MailHog API reachable", mailhogUp.status === 200, `got ${mailhogUp.status}`);
  if (health.status !== 200 || mailhogUp.status !== 200) process.exit(1);

  console.log(`\n== 1. Register ${EMAIL} and confirm via the emailed link`);
  await api("POST", "/account/methods/register", {
    body: { username: EMAIL, password: PASSWORD, subject: "E2E Registration" },
  });
  const regMail = await waitForEmail(EMAIL, "E2E Registration");
  check("registration email arrived", !!regMail, "no mail from MailHog in 30s");
  const confirmCode = regMail && codeFromUrl(regMail.html);
  check("email contains confirm link with code", !!confirmCode, regMail?.html?.slice(0, 120));
  const confirmed = await api("GET", `/account/methods/confirm/${confirmCode}`);
  check("confirm via emailed code → success", confirmed.json?.success === true, JSON.stringify(confirmed.json));
  const reConfirmed = await api("GET", `/account/methods/confirm/${confirmCode}`);
  check("reusing the same code is rejected", reConfirmed.json?.success === false || reConfirmed.status >= 400, JSON.stringify(reConfirmed.json));

  console.log("\n== 2. Login / JWT");
  const wrong = await pacedLogin({ username: EMAIL, password: PASSWORD + "wrong" });
  check("login with wrong password rejected", wrong.status >= 400, `got ${wrong.status}`);
  const login = await pacedLogin({ username: EMAIL, password: PASSWORD });
  check("login issues access_token", !!login.json?.access_token, JSON.stringify(login.json)?.slice(0, 150));
  const refresh1 = login.json?.refresh_token;
  check("login issues refresh_token", !!refresh1);
  const self = await api("GET", "/account/self", { token: login.json.access_token });
  check("/account/self with JWT → 200", self.status === 200, `got ${self.status}`);
  const anon = await api("GET", "/account/self");
  check("/account/self without JWT → 401", anon.status === 401, `got ${anon.status}`);

  console.log("\n== 3. Refresh rotation + reuse detection");
  const rot = await api("POST", "/token", { body: { grant_type: "refresh_token", refresh_token: refresh1 } });
  const refresh2 = rot.json?.refresh_token;
  check("refresh rotation issues a new pair", rot.status < 300 && !!refresh2 && refresh2 !== refresh1, JSON.stringify(rot.json)?.slice(0, 150));
  const reuse = await api("POST", "/token", { body: { grant_type: "refresh_token", refresh_token: refresh1 } });
  check("reused (rotated) refresh token rejected", reuse.status >= 400, `got ${reuse.status}`);
  const afterReuse = await api("POST", "/token", { body: { grant_type: "refresh_token", refresh_token: refresh2 } });
  check("family revoked after reuse detection", afterReuse.status >= 400, `got ${afterReuse.status}`);
  const relogin = await pacedLogin({ username: EMAIL, password: PASSWORD });
  check("fresh login still works after family revoke", !!relogin.json?.access_token, `got ${relogin.status}`);
  const A_TOKEN = relogin.json.access_token;
  const A_REFRESH = relogin.json.refresh_token;

  console.log("\n== 4. Logout");
  const out = await api("POST", "/account/methods/logout", { token: A_TOKEN });
  check("logout → success", out.json?.success === true, JSON.stringify(out.json));
  const afterOut = await api("POST", "/token", { body: { grant_type: "refresh_token", refresh_token: A_REFRESH } });
  check("refresh after logout rejected", afterOut.status >= 400, `got ${afterOut.status}`);

  console.log("\n== 5. Password reset via email");
  const resetSent = await api("POST", "/account/methods/reset", {
    body: { username: EMAIL, subject: "E2E Password Reset" },
  });
  check("reset accepted", resetSent.status < 300, `got ${resetSent.status}`);
  const resetMail = await waitForEmail(EMAIL, "E2E Password Reset");
  check("reset email arrived", !!resetMail, "no mail from MailHog in 30s");
  const resetCode = resetMail && codeFromUrl(resetMail.html);
  check("email contains reset link with code", !!resetCode);
  const change = await api("POST", `/account/methods/change/${resetCode}`, { body: { username: EMAIL, password: PASSWORD2 } });
  check("change/:code sets the new password", change.json?.success === true, JSON.stringify(change.json));
  const oldPass = await pacedLogin({ username: EMAIL, password: PASSWORD });
  check("login with old password now rejected", oldPass.status >= 400, `got ${oldPass.status}`);
  const newPass = await pacedLogin({ username: EMAIL, password: PASSWORD2 });
  check("login with new password works", !!newPass.json?.access_token, `got ${newPass.status}`);
  const A_TOKEN2 = newPass.json.access_token;

  console.log("\n== 6. 2FA (TOTP)");
  const st0 = await api("GET", "/account/methods/2fa/status", { token: A_TOKEN2 });
  check("2fa status initially off", st0.json?.enabled === false, JSON.stringify(st0.json));
  const setup = await api("POST", "/account/methods/2fa/setup", { token: A_TOKEN2, body: { method: "totp" } });
  const secret = secretFromOtpauth(setup.json?.otpauth || "");
  check("setup returns otpauth with secret", !!secret, JSON.stringify(setup.json)?.slice(0, 120));
  const badConfirm = await api("POST", "/account/methods/2fa/setup/confirm", { token: A_TOKEN2, body: { code: "000000" } });
  check("confirm with wrong TOTP rejected", badConfirm.status >= 400 || badConfirm.json?.success === false, `got ${badConfirm.status}`);
  const goodConfirm = await api("POST", "/account/methods/2fa/setup/confirm", { token: A_TOKEN2, body: { code: totp(secret) } });
  check("confirm with valid TOTP enables 2FA", goodConfirm.status < 300 && goodConfirm.json?.success !== false, JSON.stringify(goodConfirm.json)?.slice(0, 120));
  const st1 = await api("GET", "/account/methods/2fa/status", { token: A_TOKEN2 });
  check("status reports totp enabled", st1.json?.enabled === true && st1.json?.method === "totp", JSON.stringify(st1.json));

  const challenge = await pacedLogin({ username: EMAIL, password: PASSWORD2 });
  check("login with 2FA returns mfa_token, no tokens", challenge.json?.twoFactorRequired === true && !!challenge.json?.mfa_token && !challenge.json?.access_token, JSON.stringify(challenge.json)?.slice(0, 150));
  const badVerify = await api("POST", "/account/methods/2fa/verify", { body: { mfa_token: challenge.json.mfa_token, code: "000000" } });
  check("verify with wrong code rejected", badVerify.status >= 400 || badVerify.json?.success === false, `got ${badVerify.status}`);
  const goodVerify = await api("POST", "/account/methods/2fa/verify", { body: { mfa_token: challenge.json.mfa_token, code: totp(secret) } });
  check("verify with valid TOTP issues tokens", !!goodVerify.json?.access_token, JSON.stringify(goodVerify.json)?.slice(0, 120));
  const dis = await api("POST", "/account/methods/2fa/disable", { token: goodVerify.json.access_token, body: { password: PASSWORD2 } });
  check("disable with password turns 2FA off", dis.json?.success === true, JSON.stringify(dis.json));
  const plain = await pacedLogin({ username: EMAIL, password: PASSWORD2 });
  check("plain login after disable (no challenge)", !!plain.json?.access_token && !plain.json?.twoFactorRequired, `got ${plain.status}`);

  console.log("\n== 7. 2FA (email code)");
  const A_TOKEN3 = plain.json.access_token;
  const setupMail = await api("POST", "/account/methods/2fa/setup", { token: A_TOKEN3, body: { method: "email" } });
  check("email-2fa setup accepted", setupMail.status < 300, JSON.stringify(setupMail.json)?.slice(0, 120));
  const codeMail1 = await waitForEmail(EMAIL, "verification code");
  check("2fa setup email with code arrived", !!codeMail1, "no mail from MailHog in 30s");
  const emailCode1 = codeMail1 && sixDigits(codeMail1.html);
  check("email contains 6-digit code", !!emailCode1, codeMail1?.html?.slice(0, 100));
  const confirmEmail = await api("POST", "/account/methods/2fa/setup/confirm", { token: A_TOKEN3, body: { code: emailCode1 } });
  check("email-2fa enabled with emailed code", confirmEmail.status < 300 && confirmEmail.json?.success !== false, JSON.stringify(confirmEmail.json)?.slice(0, 120));
  const st2 = await api("GET", "/account/methods/2fa/status", { token: A_TOKEN3 });
  check("status reports email method", st2.json?.enabled === true && st2.json?.method === "email", JSON.stringify(st2.json));

  const challenge2 = await pacedLogin({ username: EMAIL, password: PASSWORD2 });
  check("login with email-2FA returns mfa_token", challenge2.json?.twoFactorRequired === true && !!challenge2.json?.mfa_token, JSON.stringify(challenge2.json)?.slice(0, 120));
  const codeMail2 = await waitForEmail(EMAIL, "verification code", 30000);
  const emailCode2 = codeMail2 && sixDigits(codeMail2.html);
  check("login challenge email arrived with code", !!emailCode2, "no new code mail in 30s");
  const verifyEmail = await api("POST", "/account/methods/2fa/verify", { body: { mfa_token: challenge2.json.mfa_token, code: emailCode2 } });
  check("verify with emailed code issues tokens", !!verifyEmail.json?.access_token, JSON.stringify(verifyEmail.json)?.slice(0, 120));

  console.log("\n== 8. Deactivation");
  const deact = await api("POST", "/account/methods/deactivate", { token: verifyEmail.json.access_token, body: { password: PASSWORD2 } });
  check("deactivate → success", deact.json?.success === true, JSON.stringify(deact.json));
  const deactivatedLogin = await pacedLogin({ username: EMAIL, password: PASSWORD2 });
  check("login after deactivation rejected", deactivatedLogin.status >= 400, `got ${deactivatedLogin.status}`);

  console.log("\n════════════════════════════════════");
  console.log(`E2E ${fail === 0 ? "PASSED" : "FAILED"}: ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e crashed:", e);
  process.exit(1);
});
