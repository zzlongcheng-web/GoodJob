import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { buildManagementPerformance } from "./management-performance.js";
import { parseLeadText } from "./lead-text-parser.js";

const store = getStore();
const manager = store.users.find((item) => item.email === "alex@goodjob.com");
const sales = store.users.find((item) => item.email === "shirley@goodjob.com");
assert.ok(manager && sales, "Development test users missing");

const month = "2026-11";
assert.equal(buildManagementPerformance(store, sales, month), null, "sales cannot read team management report");
assert.throws(() => buildManagementPerformance(store, manager, "2026-13"), /invalid performance month/);
const original = buildManagementPerformance(store, manager, month, new Date("2026-11-14T14:00:00Z"));
assert.ok(original && original.rows.every((row) => store.users.some((u) =>
  u.id === row.ownerId && u.teamId === manager.teamId && u.role === "sales")));
assert.equal(original?.target, 61);

const invalid = parseLeadText("Company: NoContact 1794686400000 Ltd\nContact: Nobody");
assert.equal(invalid.phone, "", "13-digit timestamp embedded in company must not be telephone");
assert.ok(invalid.missing.includes("联系方式"), "missing contacts must be marked for review");

const marker = "mgmt_test_lead_" + Date.now();
const seed = store.leads.find((lead) => lead.ownerId === sales.id && lead.teamId === sales.teamId);
assert.ok(seed, "Expected existing seed lead for test");
const newLead = { ...seed, id: marker, company: "Manager KPI Regression Ltd", status: "following" as const,
  createdAt: "2026-11-14T14:00:00.000Z", convertedCustomerId: "", convertedDealId: "" };
store.leads.push(newLead);
store.leadActivities.push({ id: marker + "_activity", leadId: marker, type: "note", operatorId: sales.id,
  content: "客户询价和交期讨论，待主管审核有效性", nextFollowAt: "", createdAt: "2026-11-14T14:10:00.000Z" });
try {
  const report = buildManagementPerformance(store, manager, month, new Date("2026-11-14T14:00:00Z"));
  const row = report?.rows.find((item) => item.ownerId === sales.id);
  assert.ok(row, "manager should see team member");
  assert.ok(row.newLeads >= 1 && row.communicationCandidates >= 1, "new lead and activity must appear");
  assert.ok(row.verifiedWhatsAppReplies <= row.communicationCandidates, "notes alone cannot count as verified replies");
  assert.equal(row.target, 61);
} finally {
  store.leads.splice(store.leads.findIndex((lead) => lead.id === marker), 1);
  store.leadActivities.splice(store.leadActivities.findIndex((activity) => activity.id === marker + "_activity"), 1);
}

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot open HTTP test server");
const base = "http://127.0.0.1:" + address.port;
async function call(path: string, token = "", body?: unknown) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, json: await response.json() as Record<string, any> };
}
async function login(email: string) {
  const r = await call("/api/auth/login", "", { email, password: "goodjob123" });
  assert.equal(r.status, 200, "login " + email);
  return String(r.json.token);
}
try {
  const managerToken = await login("alex@goodjob.com");
  const salesToken = await login("shirley@goodjob.com");
  const route = "/api/reports/executive?managementMonth=2026-11";
  assert.equal((await call(route)).status, 401);
  assert.equal((await call("/api/reports/executive?managementMonth=2026-13", managerToken)).status, 400);
  const boss = await call(route, managerToken);
  assert.equal(boss.status, 200);
  assert.ok(boss.json.management && Array.isArray(boss.json.management.rows));
  assert.equal(boss.json.management.target, 61);
  const employee = await call(route, salesToken);
  assert.equal(employee.status, 200);
  assert.equal(employee.json.management, null, "business users may not see manager-only scoreboard");
  console.log("management-performance-test passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
