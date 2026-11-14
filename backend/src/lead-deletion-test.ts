import { app } from "./server.js";
import { getStore } from "./store.js";

const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Cannot start lead deletion test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  return { response, json: await response.json() };
}

async function login(email: string) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "goodjob123" })
  });
  if (!result.response.ok) throw new Error(`login failed: ${email}`);
  return result.json.token as string;
}

async function createLead(token: string, suffix: string) {
  const result = await request("/api/leads", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ company: `线索删除回归-${suffix}`, source: "自动化测试" })
  });
  if (!result.response.ok || !result.json.lead?.id) throw new Error("lead create failed");
  return result.json.lead.id as string;
}

try {
  const ownerToken = await login("shirley@goodjob.com");
  const otherToken = await login("mia@goodjob.com");
  const managerToken = await login("alex@goodjob.com");

  const plainLeadId = await createLead(ownerToken, `plain-${Date.now()}`);
  const crossOwnerDelete = await request(`/api/leads/${plainLeadId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({ reason: "越权删除" })
  });
  // 业务员删除线索一律被拒绝（403）；即使越权访问他人线索，也只能得到 403/404，且数据保持不变
  if (![403, 404].includes(crossOwnerDelete.response.status)) throw new Error("lead delete must preserve owner isolation");
  if (!getStore().leads.some((item) => item.id === plainLeadId && !item.deletedAt)) throw new Error("denied delete must keep the lead");

  // 业务员不能删除线索（含移入垃圾箱和永久删除），只能标记无效并写明原因
  const salesDelete = await request(`/api/leads/${plainLeadId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ reason: "想删除" })
  });
  if (salesDelete.response.status !== 403) throw new Error("sales must not delete leads");
  const invalidNoReason = await request(`/api/leads/${plainLeadId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "invalid" })
  });
  if (invalidNoReason.response.status !== 400) throw new Error("marking invalid must require a reason");
  const invalidWithReason = await request(`/api/leads/${plainLeadId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "invalid", remark: "客户号码为空号，无法联系" })
  });
  if (!invalidWithReason.response.ok || invalidWithReason.json.lead?.status !== "invalid" || invalidWithReason.json.lead?.deletedAt) {
    throw new Error("sales should be able to mark lead invalid with a reason");
  }
  if (!getStore().leads.some((item) => item.id === plainLeadId)) throw new Error("invalid lead must be kept");

  const trash = await request(`/api/leads/${plainLeadId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ reason: "无效线索" })
  });
  if (!trash.response.ok || !trash.json.lead?.deletedAt) throw new Error("lead trash failed");

  const restore = await request(`/api/leads/${plainLeadId}/restore`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` }
  });
  if (!restore.response.ok || restore.json.lead?.deletedAt) throw new Error("lead restore failed");

  await request(`/api/leads/${plainLeadId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ reason: "永久清理前置" })
  });
  const salesPermanent = await request(`/api/leads/${plainLeadId}/permanent`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` }
  });
  if (salesPermanent.response.status !== 403) throw new Error("sales must not permanently delete leads");
  const permanent = await request(`/api/leads/${plainLeadId}/permanent`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (!permanent.response.ok || !permanent.json.ok) throw new Error("lead permanent delete failed");

  const convertedLeadId = await createLead(ownerToken, `converted-${Date.now()}`);
  const conversion = await request(`/api/leads/${convertedLeadId}/convert`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      customerMode: "create",
      createDeal: true,
      deal: { title: "线索删除回归商机", product: "测试产品", amount: 1200 }
    })
  });
  if (!conversion.response.ok || !conversion.json.customer?.id || !conversion.json.deal?.id) {
    throw new Error("lead conversion setup failed");
  }

  const convertedTrash = await request(`/api/leads/${convertedLeadId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` },
    body: JSON.stringify({ reason: "转化完成后清理线索工作区" })
  });
  if (!convertedTrash.response.ok || !convertedTrash.json.lead?.deletedAt) {
    throw new Error("converted lead should move to trash");
  }
  const store = getStore();
  if (!store.customers.some((item) => item.id === conversion.json.customer.id)) {
    throw new Error("converted customer must survive lead deletion");
  }
  if (!store.deals.some((item) => item.id === conversion.json.deal.id)) {
    throw new Error("converted deal must survive lead deletion");
  }

  const convertedPermanent = await request(`/api/leads/${convertedLeadId}/permanent`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${managerToken}` }
  });
  if (convertedPermanent.response.status !== 400) {
    throw new Error("converted lead source record must reject permanent deletion");
  }

  console.log(JSON.stringify({
    ok: true,
    ownerIsolation: true,
    trashAndRestore: true,
    permanentDelete: true,
    convertedCustomerAndDealPreserved: true
  }, null, 2));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
