import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";
import { buildManagementPerformance } from "./management-performance.js";
import { calculateMonthlyNewCustomerPerformance } from "./monthly-new-customer-performance.js";
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
assert.equal(original?.timezone, "Asia/Shanghai", "management business dates must use Beijing/Shanghai time");

const invalid = parseLeadText("Company: NoContact 1794686400000 Ltd\nContact: Nobody");
assert.equal(invalid.phone, "", "13-digit timestamp embedded in company must not be telephone");
assert.ok(invalid.missing.includes("联系方式"), "missing contacts must be marked for review");

const marker = "mgmt_test_lead_" + Date.now();
const seed = store.leads.find((lead) => lead.ownerId === sales.id && lead.teamId === sales.teamId);
assert.ok(seed, "Expected existing seed lead for test");
const newLead = { ...seed, id: marker, company: "Manager KPI Regression Ltd", status: "following" as const,
  createdAt: "2026-11-14T14:00:00.000Z", convertedCustomerId: "", convertedDealId: "" };
store.leads.push(newLead);
store.leads.push({ ...newLead, id: marker + '_second_import' });
store.leadActivities.push({ id: marker + "_activity", leadId: marker, type: "note", operatorId: sales.id,
  content: "客户询价和交期讨论，待主管审核有效性", nextFollowAt: "", createdAt: "2026-11-14T14:10:00.000Z" });
try {
  const report = buildManagementPerformance(store, manager, month, new Date("2026-11-14T14:00:00Z"));
  const row = report?.rows.find((item) => item.ownerId === sales.id);
  assert.ok(row, "manager should see team member");
  assert.ok(row.newLeads >= 1 && row.communicationCandidates >= 1, "new lead and activity must appear");
  const oldRow = original?.rows.find((item) => item.ownerId === sales.id);
  assert.equal(row.newLeads, (oldRow?.newLeads || 0) + 1, "multiple imports of one company must count once");
  assert.equal(row.target, 61);

  // 已核实回复必须是双向证据：只有客户入站、没有我方出站 → 不计；补上出站后 → +1
  const baseCustomer = store.customers.find((c) => c.ownerId === sales.id && c.teamId === sales.teamId);
  assert.ok(baseCustomer, "Expected an owned customer for verified-reply test");
  // Fresh customer: no earlier communication, so it is genuinely "new" in the KPI month.
  const ownedCustomer = { ...baseCustomer, id: marker + "_cust", company: "Dashboard KPI Fresh Customer Ltd", poolStatus: "owned" as const };
  store.customers.push(ownedCustomer);
  const linked = store.leads.find((lead) => lead.id === marker);
  assert.ok(linked);
  linked.convertedCustomerId = ownedCustomer.id;
  const before = buildManagementPerformance(store, manager, month, new Date("2026-11-14T14:00:00Z"))
    ?.rows.find((item) => item.ownerId === sales.id)?.verifiedWhatsAppReplies ?? 0;
  const waBase = { customerId: ownedCustomer.id, content: "t", contentTranslated: "", mediaUrl: "", status: "delivered" };
  store.whatsappMessages.push({ ...waBase, id: marker + "_in", direction: "inbound", waMessageId: marker + "_in", createdAt: "2026-11-14T15:00:00.000Z" });
  const inboundOnly = buildManagementPerformance(store, manager, month, new Date("2026-11-14T16:00:00Z"))
    ?.rows.find((item) => item.ownerId === sales.id)?.verifiedWhatsAppReplies ?? 0;
  assert.equal(inboundOnly, before, "inbound-only WhatsApp must not count as a verified reply");
  store.whatsappMessages.push({ ...waBase, id: marker + "_out", direction: "outbound", waMessageId: marker + "_out", createdAt: "2026-11-14T14:50:00.000Z" });
  const twoWay = buildManagementPerformance(store, manager, month, new Date("2026-11-14T16:00:00Z"))
    ?.rows.find((item) => item.ownerId === sales.id)?.verifiedWhatsAppReplies ?? 0;
  assert.equal(twoWay, before + 1, "two-way WhatsApp evidence counts as one verified reply");
  // Dashboard must equal the authoritative monthly endpoint calculation.
  const auth = calculateMonthlyNewCustomerPerformance({
    month, customers: store.customers.filter((c) => c.teamId === manager.teamId), activities: store.customerActivities,
    whatsappMessages: store.whatsappMessages, ownerIds: [sales.id], asOf: "2026-11-14T16:00:00Z"
  }).members.find((item) => item.ownerId === sales.id);
  assert.equal(twoWay, auth?.independentlyVerifiedCount, "dashboard verified count must equal the authoritative KPI module");
} finally {
  for (const id of [marker + "_in", marker + "_out"]) {
    const i = store.whatsappMessages.findIndex((m) => m.id === id);
    if (i >= 0) store.whatsappMessages.splice(i, 1);
  }
  const custIndex = store.customers.findIndex((c) => c.id === marker + "_cust");
  if (custIndex >= 0) store.customers.splice(custIndex, 1);
  store.leads.splice(store.leads.findIndex((lead) => lead.id === marker), 1);
  store.leads.splice(store.leads.findIndex((lead) => lead.id === marker + "_second_import"), 1);
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
