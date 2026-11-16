import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../src/server/app";
import { inMemoryDatabasePaths } from "./helpers/test-database";

const secret = "ownership-test-secret-at-least-32-characters";

function token(userId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ sub: userId, ver: 1, iss: "goodjob-crm", aud: "goodjob-crm-web", exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("personal WhatsApp ownership", () => {
  let runtime: AppRuntime;
  const alice = { authorization: `Bearer ${token("user-alice")}` };
  const bob = { authorization: `Bearer ${token("user-bob")}` };
  let accountId = "";
  let contactId = "";
  let conversationId = "";

  beforeAll(async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wa-owner-test-"));
    runtime = await createAppRuntime({
      nodeEnv: "test",
      port: 0,
      webOrigin: "http://localhost:5173",
      databaseClient: "pglite",
      ...inMemoryDatabasePaths(directory),
      sessionMasterKey: randomBytes(32).toString("base64"),
      seedDemo: false,
      allowPrivateAiEndpoints: false,
      crmJwtSecret: secret
    });
    const created = await request(runtime.app)
      .post("/api/v1/accounts")
      .set(alice)
      .send({ name: "Alice WhatsApp", provider: "baileys", riskAccepted: true })
      .expect(201);
    accountId = created.body.id;
    const added = await request(runtime.app)
      .post("/api/v1/contacts")
      .set(alice)
      .send({ accountId, displayName: "Alice Only Contact", phone: "+14155550115" })
      .expect(201);
    contactId = added.body.contact.id;
    conversationId = added.body.conversation.id;
  });

  afterAll(async () => runtime.close());

  it("does not list or access another user's account", async () => {
    await request(runtime.app).get("/api/v1/accounts").set(bob).expect(200).expect([]);
    await request(runtime.app).get(`/api/v1/accounts/${accountId}/meta`).set(bob).expect(404);
    await request(runtime.app).post(`/api/v1/accounts/${accountId}/connect`).set(bob).send({}).expect(404);
  });

  it("blocks cross-employee contact, conversation, message and media operations", async () => {
    await request(runtime.app).get("/api/v1/conversations").set(bob).expect(200).expect([]);
    await request(runtime.app).get("/api/v1/contacts").set(bob).expect(200).expect([]);
    await request(runtime.app).get(`/api/v1/conversations?accountId=${accountId}`).set(bob).expect(404);
    await request(runtime.app).get(`/api/v1/conversations/${conversationId}/messages`).set(bob).expect(404);
    await request(runtime.app).post(`/api/v1/contacts/${contactId}/conversation`).set(bob).expect(404);

    // The wrong-account case must return 404 as well: 409 would leak that Alice's
    // conversation id is real despite Bob having no access to it.
    await request(runtime.app)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(bob)
      .send({ accountId: "00000000-0000-4000-8000-000000000002", clientMessageId: "bob-foreign-write-001", body: "not authorized" })
      .expect(404);

    await request(runtime.app)
      .post(`/api/v1/conversations/${conversationId}/media`)
      .set(bob)
      .query({ accountId, clientMessageId: "bob-foreign-media-001", kind: "file", fileName: "test.txt", mimeType: "text/plain" })
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("access denied"))
      .expect(404);

    const aliceMessages = await request(runtime.app)
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set(alice).expect(200);
    expect(Array.isArray(aliceMessages.body)).toBe(true);
  });

  it("denies destructive WhatsApp operations to regular sales staff", async () => {
    await request(runtime.app).delete(`/api/v1/accounts/${accountId}`).set(alice).expect(403);
    await request(runtime.app)
      .post("/api/v1/messages/00000000-0000-4000-8000-000000000002/revoke")
      .set(alice).send({ accountId }).expect(403);
    await request(runtime.app).delete(`/api/v1/accounts/${accountId}`)
      .set({ ...alice, "x-crm-role": "admin" }).expect(403);
    const intact = await request(runtime.app).get("/api/v1/accounts").set(alice).expect(200);
    expect(intact.body).toHaveLength(1);
  });

  it("rejects missing and forged session identities", async () => {
    await request(runtime.app).get("/api/v1/accounts").expect(401);
    await request(runtime.app).get("/api/v1/accounts").set({ authorization: `Bearer ${token("user-bob")}x` }).expect(401);
  });
});
