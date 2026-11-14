import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelAccount } from "../src/shared/types";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { inMemoryDatabasePaths } from "./helpers/test-database";
import { createDatabase } from "../src/server/db/database";
import { migrate } from "../src/server/db/migrate";
import { Repository } from "../src/server/db/repository";
import { seed, seedDemo } from "../src/server/db/seed";

// 风险修复回归：删除账号会通过外键级联清空该账号下全部会话和消息，默认必须禁止。
describe("WhatsApp account deletion is disabled by default", () => {
  let runtime: AppRuntime;
  let accounts: ChannelAccount[];
  const previous = process.env.PLUGIN_ALLOW_ACCOUNT_DELETE;

  beforeAll(async () => {
    delete process.env.PLUGIN_ALLOW_ACCOUNT_DELETE;
    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-crm-delete-guard-"));
    const config = {
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      ...inMemoryDatabasePaths(directory),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: true,
      allowPrivateAiEndpoints: false
    } as const;
    const fixtureDatabase = await createDatabase(config);
    await migrate(fixtureDatabase);
    const fixtureRepository = new Repository(fixtureDatabase);
    await seed(fixtureDatabase, fixtureRepository, config);
    await seedDemo(fixtureDatabase, fixtureRepository, config);
    await fixtureDatabase.close();
    runtime = await createAppRuntime(config);
    accounts = (await request(runtime.app).get("/api/v1/accounts").expect(200)).body as ChannelAccount[];
  }, 30_000);

  afterAll(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PLUGIN_ALLOW_ACCOUNT_DELETE;
    else process.env.PLUGIN_ALLOW_ACCOUNT_DELETE = previous;
  });

  it("returns 403 and keeps the account", async () => {
    expect(accounts.length).toBeGreaterThan(0);
    const target = accounts[0];
    const denied = await request(runtime.app).delete(`/api/v1/accounts/${target.id}`);
    expect(denied.status).toBe(403);
    const after = await request(runtime.app).get("/api/v1/accounts").expect(200);
    expect((after.body as ChannelAccount[]).some((account) => account.id === target.id)).toBe(true);
  });

  it("allows deletion only when the isolated switch is explicitly enabled", async () => {
    process.env.PLUGIN_ALLOW_ACCOUNT_DELETE = "true";
    const target = accounts[accounts.length - 1];
    const result = await request(runtime.app).delete(`/api/v1/accounts/${target.id}`);
    expect([204, 409]).toContain(result.status);
    delete process.env.PLUGIN_ALLOW_ACCOUNT_DELETE;
  });
});
