import assert from "node:assert/strict";
import { app } from "./server.js";
import { getStore } from "./store.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start lead text API test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, token = "", body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, any> };
}

async function login(email: string) {
  const result = await request("/api/auth/login", "", { email, password: "goodjob123" });
  assert.equal(result.status, 200, `login failed: ${email}`);
  return String(result.json.token);
}

const stamp = Date.now();
const block = (name: string, n: number) =>
  `Company: ${name} ${stamp} Trading Ltd\nContact: Buyer ${name}\nTel: +234 803 ${String(1000 + n)} 0000\nEmail: buyer${n}@${name.toLowerCase()}${stamp}.com\nLooking for pellet mill`;

try {
  const sales = await login("shirley@goodjob.com");
  const other = await login("mia@goodjob.com");
  const leadCount = () => getStore().leads.length;

  // 1 未登录
  assert.equal((await request("/api/leads/parse-text", "", { text: block("Alpha", 1) })).status, 401);
  assert.equal((await request("/api/leads/parse-batch", "", { text: block("Alpha", 1) })).status, 401);

  // 2 单条：save=false 只出草稿，不入库
  const before = leadCount();
  const draft = await request("/api/leads/parse-text", sales, { text: block("Alpha", 1) });
  assert.equal(draft.status, 200);
  assert.equal(draft.json.draft.company, `Alpha ${stamp} Trading Ltd`);
  assert.equal(draft.json.draft.country, "尼日利亚");
  assert.equal(leadCount(), before, "save=false must not write");

  // 3 单条：save=true 入库，来源和原文保留
  const saved = await request("/api/leads/parse-text", sales, { text: block("Alpha", 1), save: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.lead.source, "粘贴识别");
  assert.ok(String(saved.json.lead.inquiryContent).includes("Looking for pellet mill"));
  assert.equal(leadCount(), before + 1);

  // 4 重复 → 409，不新增
  const dup = await request("/api/leads/parse-text", sales, { text: block("Alpha", 1), save: true });
  assert.equal(dup.status, 409);
  assert.equal(leadCount(), before + 1);

  // 5 缺公司名 → 400
  const noCompany = await request("/api/leads/parse-text", sales, { text: "hello, call me +234 803 111 2222", save: true });
  assert.equal(noCompany.status, 400);

  // 6 批量核对：2 个可录入、1 个与系统重复、1 个缺联系方式
  const batchText = [block("Alpha", 1), block("Beta", 2), block("Gamma", 3), `Company: NoContact ${stamp} Ltd\nContact: Nobody`].join("\n\n");
  const preview = await request("/api/leads/parse-batch", sales, { text: batchText });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.total, 4);
  assert.equal(preview.json.ready, 2);
  assert.equal(preview.json.duplicate, 1);
  assert.equal(preview.json.needsFix, 1);
  assert.equal(leadCount(), before + 1, "batch preview must not write");

  // 7 只录入选中的第 2 家（Beta）
  const partial = await request("/api/leads/parse-batch", sales, { text: batchText, save: true, indexes: [2] });
  assert.equal(partial.status, 200);
  assert.equal(partial.json.created.length, 1);
  assert.ok(String(partial.json.created[0].company).includes("Beta"));
  assert.equal(leadCount(), before + 2);

  // 8 全部录入：Beta 已存在变重复，只新增 Gamma；缺联系方式的被跳过并说明原因
  const rest = await request("/api/leads/parse-batch", sales, { text: batchText, save: true });
  assert.equal(rest.status, 200);
  assert.equal(rest.json.created.length, 1);
  assert.ok(String(rest.json.created[0].company).includes("Gamma"));
  assert.ok(rest.json.skipped.some((item: { reason: string }) => item.reason.includes("缺少联系方式")));
  assert.equal(leadCount(), before + 3);

  // 9 本次粘贴内容里重复
  const selfDup = await request("/api/leads/parse-batch", sales, { text: `${block("Delta", 4)}\n\n${block("Delta", 4)}` });
  assert.equal(selfDup.json.ready, 1);
  assert.equal(selfDup.json.duplicate, 1);

  // 10 超过 50 家 → 400
  const many = Array.from({ length: 51 }, (_, i) => block(`Many${i}x`, i + 10)).join("\n\n");
  assert.equal((await request("/api/leads/parse-batch", sales, { text: many })).status, 400);

  // 11 隔离：另一位业务员看不到 shirley 粘贴录入的线索
  const otherLeads = await request("/api/leads", other);
  assert.ok(!(otherLeads.json.leads as Array<{ company: string }>).some((lead) => lead.company.includes(`Alpha ${stamp}`)));

  console.log(JSON.stringify({ ok: true, singleDraft: true, singleSave: true, duplicate: true, batchPreview: true, partialSave: true, limit50: true, isolation: true }));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
