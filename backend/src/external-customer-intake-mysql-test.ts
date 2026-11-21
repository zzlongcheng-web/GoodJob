import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { app } from "./server.js";
import { publicUser, signToken } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import { getStore, setStore } from "./store.js";
import { intakeTokenDigest } from "./external-customer-intake-policy.js";

// Fail before connecting unless the explicit ephemeral test profile and loopback admin URL are provided.
assert.equal(process.env.NODE_ENV,"test");
assert.equal(process.env.APP_DATABASE_PROFILE,"test");
const configured = process.env.MYSQL_TEST_ADMIN_URL;
if (!configured) throw new Error("MYSQL_TEST_ADMIN_URL is required");
const adminUrl = new URL(configured);
assert.equal(adminUrl.protocol,"mysql:");
assert.ok(["127.0.0.1","localhost","[::1]"].includes(adminUrl.hostname),"only local test MySQL is allowed");
const database = "goodjob_intake_test_" + randomUUID().replaceAll("-","").slice(0,16);
const original = getStore();
const admin = await mysql.createConnection(configured);
let createdDatabase = false;
let store: Awaited<ReturnType<typeof createMysqlStore>> | undefined;
let server: ReturnType<typeof app.listen> | undefined;
try {
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  createdDatabase = true;
  const dbUrl = new URL(configured);
  dbUrl.pathname = "/" + database;
  process.env.DATABASE_URL = dbUrl.toString();
  delete process.env.MYSQL_URL;
  process.env.CRM_SEED_DEVELOPMENT_DATA = "true";
  store = await createMysqlStore();
  setStore(store);
  server = app.listen(0,"127.0.0.1");
  if (!server.listening) await once(server,"listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const prefix = "/api/external-customer-intake";
  async function call(path: string, method = "GET", token = "", body?: unknown, extraHeaders: Record<string,string> = {}) {
    const response = await fetch(base + path,{method,headers:{
      "content-type":"application/json", ...(token ? {authorization:"Bearer "+token} : {}), ...extraHeaders
    }, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {code:response.status,body:await response.json() as Record<string,any>};
  }
  const owner = store.users.find(u=>u.id==="u_sales_shirley")!;
  const colleague = store.users.find(u=>u.id==="u_sales_mia")!;
  const manager = store.users.find(u=>u.id==="u_admin")!;
  assert.ok(owner && colleague && manager);
  assert.equal(owner.teamId,colleague.teamId);
  const session = signToken(publicUser(owner));
  const colleagueSession = signToken(publicUser(colleague));
  const managerSession = signToken(publicUser(manager));
  // Give the fixture explicit least-privilege IAM grants; this test verifies intake enforcement,
  // while production IAM provisioning remains owned by the existing CRM authorization system.
  store.validateIamSession = async () => ({valid:true});
  store.getIamCapabilitySnapshot = async actor => ({
    source:"tenant",
    permissions: actor.id===manager.id
      ? {"customer.read":["tenant"],"customer.create":["tenant"],"member.manage":["tenant"]}
      : {"customer.read":["self"],"customer.create":["self"]},
    roleNames: actor.id===manager.id ? ["test-admin"] : ["test-sales"]
  });
  store.resolveIamDataScope = async actor => ({tenantWide:false,ownerIds:[actor.id]});
  const issue = async (jwt: string) => {
    const response = await call(prefix+"/tokens","POST",jwt,{label:"isolated test"});
    assert.equal(response.code,201,"issue must succeed for authorized employee");
    assert.match(response.body.token,/^gj_intake_[A-Za-z0-9_-]{43}$/);
    return response.body as {token:string;record:{id:string}};
  };

  process.env.EXTERNAL_CUSTOMER_INTAKE_ENABLED = "false";
  assert.equal((await call(prefix+"/tokens","POST",session,{})).code,503);
  process.env.EXTERNAL_CUSTOMER_INTAKE_ENABLED = "true";
  assert.equal((await call(prefix+"/tokens","POST","",{})).code,401);
  assert.equal((await call(prefix+"/tokens","POST","",{},{
    cookie:"gj_session="+session+"; gj_csrf=test_csrf"
  })).code,403,"cookie-authenticated token issuance must enforce CSRF");
  const a = await issue(session), b = await issue(colleagueSession);
  const [hashRows] = await admin.execute<RowDataPacket[]>(`SELECT digest FROM \`${database}\`.external_customer_intake_tokens WHERE id=?`,[a.record.id]);
  assert.equal(hashRows[0]?.digest,intakeTokenDigest(a.token));
  assert.notEqual(hashRows[0]?.digest,a.token);
  const mine = await call(prefix+"/tokens","GET",session);
  assert.equal(mine.code,200);
  assert.ok(mine.body.tokens.some((t:any)=>t.id===a.record.id));
  assert.ok(!mine.body.tokens.some((t:any)=>t.id===b.record.id));
  assert.ok(!JSON.stringify(mine.body).includes(a.token));
  assert.equal((await call(prefix+"/tokens?scope=team","GET",session)).code,403);
  assert.equal((await call(prefix+"/tokens/"+b.record.id,"DELETE",session)).code,404);
  assert.equal((await call("/api/customers","GET",a.token)).code,401);
  assert.equal((await call(prefix+"/tokens","POST",a.token,{})).code,401);
  const initialActivities = store.customerActivities.length;
  const customer = {company:"Intake Fixture "+randomUUID(),country:"德国",companyFullName:"Intake Fixture GmbH "+randomUUID(),email:"fixture-"+randomUUID()+"@example.test",phone:"+491234567890",otherNotes:"virtual test only"};
  assert.equal((await call(prefix+"/create","POST",session,customer)).code,401,"session JWT cannot substitute for scoped token");
  assert.equal((await call(prefix+"/create","POST",a.token,{...customer,ownerId:colleague.id})).code,400);
  assert.equal((await call(prefix+"/create","POST",a.token,{...customer,country:"未知"})).code,400);
  assert.equal((await call(prefix+"/check","POST",a.token,customer)).body.status,"clear");
  // A fixture in another team must never block this team's intake.
  await admin.execute(`INSERT INTO \`${database}\`.customers (id,company,country,owner_id,team_id,email) VALUES (?,?,?,?,?,?)`,["cross_"+randomUUID(),customer.company,customer.country,"other_owner","other_team",customer.email]);
  assert.equal((await call(prefix+"/check","POST",a.token,customer)).body.status,"clear");
  const attempts = await Promise.all([call(prefix+"/create","POST",a.token,customer),call(prefix+"/create","POST",b.token,customer)]);
  assert.deepEqual(attempts.map(x=>x.code).sort(),[201,409], "concurrent requests must create exactly one customer");
  const winnerIndex = attempts.findIndex(x=>x.code===201);
  const winner = attempts[winnerIndex].body;
  const expectedOwner = winnerIndex===0 ? owner.id : colleague.id;
  assert.ok(winner.customerId);
  const [customers] = await admin.execute<RowDataPacket[]>(`SELECT * FROM \`${database}\`.customers WHERE team_id=? AND email=?`,[owner.teamId,customer.email]);
  assert.equal(customers.length,1);
  assert.equal(customers[0].owner_id,expectedOwner);
  assert.equal(customers[0].id,winner.customerId);
  assert.equal(customers[0].stage,"询盘");
  assert.equal(customers[0].lifecycle_status,"open");
  assert.equal(Number(customers[0].amount),0);
  assert.equal(store.customerActivities.length,initialActivities,"intake does not fabricate communication");
  const duplicate = await call(prefix+"/create","POST",a.token,{...customer,company:"Changed name",otherNotes:"must not overwrite"});
  assert.equal(duplicate.code,409);
  assert.ok(!("existingId" in duplicate.body) && !("customerId" in duplicate.body));
  assert.equal(store.customers.find(c=>c.id===winner.customerId)?.otherNotes,"virtual test only");
  assert.equal((await call("/api/customers/"+winner.customerId,"DELETE",a.token)).code,401);
  // A revoked grant cannot be reused by either an already paired local client or a new request.
  assert.equal((await call(prefix+"/tokens/"+b.record.id,"DELETE",managerSession)).code,200);
  assert.equal((await call(prefix+"/check","POST",b.token,customer)).code,401);
  const expired = await issue(session);
  await admin.execute(`UPDATE \`${database}\`.external_customer_intake_tokens SET expires_at_ms=? WHERE id=?`,[Date.now()-1,expired.record.id]);
  assert.equal((await call(prefix+"/check","POST",expired.token,customer)).code,401);
  const status = owner.status;
  owner.status = "disabled";
  assert.equal((await call(prefix+"/check","POST",a.token,customer)).code,401);
  owner.status = status;
  const previous = owner.authVersion;
  owner.authVersion = (previous || 1)+1;
  assert.equal((await call(prefix+"/check","POST",a.token,customer)).code,401);
  owner.authVersion = previous;
  const snapshot = store.getIamCapabilitySnapshot;
  assert.ok(snapshot);
  store.getIamCapabilitySnapshot = async actor => {
    const result = await snapshot(actor);
    return actor.id===owner.id ? {...result,permissions:{}} : result;
  };
  assert.equal((await call(prefix+"/create","POST",a.token,customer)).code,403);
  store.getIamCapabilitySnapshot = snapshot;
  const [audits] = await admin.execute<RowDataPacket[]>(`SELECT action,outcome FROM \`${database}\`.external_customer_intake_audit WHERE team_id=?`,[owner.teamId]);
  assert.ok(audits.some(r=>r.action==="create" && r.outcome==="created"));
  assert.ok(audits.some(r=>r.action==="create" && r.outcome==="duplicate"));
  assert.ok(audits.some(r=>r.action==="revoke" && r.outcome==="ok"));
  console.log("external customer intake isolated HTTP + MySQL tests passed");
} finally {
  if (server) await new Promise<void>(resolve=>server!.close(()=>resolve()));
  setStore(original);
  try { await store?.close?.(); }
  finally {
    try { if (createdDatabase) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
  }
}
