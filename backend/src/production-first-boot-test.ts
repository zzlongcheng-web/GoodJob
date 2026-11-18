import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import type mysql from "mysql2/promise";
import { ensureInitialSuperAdmin, disableLegacyBuiltInSuperAdmin } from "./mysql-store.js";

interface AdminRow { id: string; email: string; status: string; auth_version: number }
const users: AdminRow[] = [{ id: "u_superadmin", email: "superadmin@goodjob.com", status: "active", auth_version: 1 }];
let insertCount = 0;
const fakePool = {
  async query(query: string, params: unknown[] = []) {
    if (query.startsWith("SELECT id FROM users WHERE id =")) {
      const [id, email] = params;
      return [users.filter(row => row.id === id || row.email === email), []];
    }
    if (query.startsWith("SELECT COUNT(*) AS total FROM users")) {
      return [[{ total: users.filter(row => row.id !== "u_superadmin").length }], []];
    }
    if (query.startsWith("INSERT INTO users")) {
      const [id, _name, email] = params;
      users.push({ id: String(id), email: String(email), status: "active", auth_version: 1 });
      insertCount++;
      return [{ affectedRows: 1 }, []];
    }
    if (query.startsWith("UPDATE users SET status = 'disabled'")) {
      const user = users.find(row => row.id === "u_superadmin" && row.status !== "disabled");
      if (user) { user.status = "disabled"; user.auth_version++; }
      return [{ affectedRows: user ? 1 : 0 }, []];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }
} as unknown as mysql.Pool;

const previous = Object.fromEntries(["NODE_ENV", "INITIAL_ADMIN_EMAIL", "INITIAL_ADMIN_PASSWORD", "INITIAL_ADMIN_NAME"].map(k => [k, process.env[k]]));
try {
  process.env.NODE_ENV = "production";
  process.env.INITIAL_ADMIN_EMAIL = "owner@example.com";
  process.env.INITIAL_ADMIN_PASSWORD = "random-test-only-password-longer-than-twelve";
  process.env.INITIAL_ADMIN_NAME = "Owner";
  assert.equal(await ensureInitialSuperAdmin(fakePool), true, "first install must provision owner's actual account");
  assert.equal(users.some(x => x.id === "u_initial_super_admin" && x.email === "owner@example.com"), true);
  assert.equal(await disableLegacyBuiltInSuperAdmin(fakePool), true, "legacy fixed credential must be disabled");
  assert.equal(users[0].status, "disabled");
  assert.equal(users[0].auth_version, 2, "invalidate legacy sessions");
  assert.equal(await disableLegacyBuiltInSuperAdmin(fakePool), false, "idempotent revocation");
  assert.equal(await ensureInitialSuperAdmin(fakePool), false, "no account overwrite on rerun");
  assert.equal(insertCount, 1);
  process.env.INITIAL_ADMIN_EMAIL = "admin@goodjob.com";
  await assert.rejects(ensureInitialSuperAdmin(fakePool), /company email/);
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

const privateDir = mkdtempSync(join(tmpdir(), "goodjob-website-firstboot-"));
try {
  const cli = resolve("dist/bootstrap-website-lead-ingress.js");
  const env = { ...process.env, NODE_ENV: "production", GOODJOB_WEBSITE_LEAD_PRIVATE_DIR: privateDir };
  const first = spawnSync(process.execPath, [cli], { env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).reused, false);
  const files = readdirSync(privateDir);
  assert.deepEqual(files.sort(), ["website-lead-ingress.enc.json", "website-lead-ingress.key"].sort());
  const encrypted = readFileSync(join(privateDir, "website-lead-ingress.enc.json"), "utf8");
  assert.ok(!encrypted.includes("u_initial_super_admin"), "settings must be encrypted at rest");
  for (const file of files) assert.equal(statSync(join(privateDir, file)).mode & 0o777, 0o600);
  const again = spawnSync(process.execPath, [cli], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).reused, true);
  assert.equal(readFileSync(join(privateDir, "website-lead-ingress.enc.json"), "utf8"), encrypted, "must not rotate keys on deployment rerun");
  const p = join(privateDir, "website-lead-ingress.enc.json");
  writeFileSync(p, encrypted.replace(/"ciphertext":\s*"[^"]+"/, '"ciphertext": "tampered"'));
  const tampered = spawnSync(process.execPath, [cli], { env, encoding: "utf8" });
  assert.notEqual(tampered.status, 0, "tampering must fail closed");
} finally {
  rmSync(privateDir, { recursive: true, force: true });
}
console.log("production-first-boot-test: bootstrap, legacy-account revocation, encrypted persistence, tamper guard passed");
