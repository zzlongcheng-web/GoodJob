import { canSeeOwner } from "./auth.js";
import { entityDuplicateKey } from "./entity-duplicates.js";
import type { SessionUser } from "./types.js";
import type { getStore } from "./store.js";

/** Read-only manager metrics; no CRM state changes or unverified performance claims. */
type Store = ReturnType<typeof getStore>;
const GOAL = 61;
const ZONE = "America/New_York";
function businessDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (name: string) => parts.find((item) => item.type === name)?.value || "";
  return part("year") + "-" + part("month") + "-" + part("day");
}
function dueDate(value: string) { return (value || "").slice(0, 10); }
function moneyByCurrency(deals: Store["deals"]) {
  const totals = new Map<string, number>();
  for (const d of deals) {
    const currency = d.currency || "未设置";
    totals.set(currency, Math.round(((totals.get(currency) || 0) + d.amount) * 100) / 100);
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
export function buildManagementPerformance(store: Store, viewer: SessionUser, month: string, now = new Date()) {
  if (!/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error("invalid performance month");
  if (!["admin", "manager"].includes(viewer.role) || viewer.iamSource === "platform") return null;
  const today = businessDate(now);
  const monthPrefix = month + "-";
  const members = store.users.filter((u) => u.status === "active" && u.role === "sales"
    && u.teamId === viewer.teamId && canSeeOwner(viewer, u.id, u.teamId));
  const rows = members.map((member) => {
    const id = member.id;
    const leads = store.leads.filter((lead) => lead.ownerId === id && lead.teamId === member.teamId
      && !lead.deletedAt && lead.status !== "invalid" && businessDate(lead.createdAt).startsWith(monthPrefix));
    // A company's multiple imports/lead IDs count as only one new prospect.
    const leadGroups = new Map<string, typeof leads>();
    for (const lead of leads) {
      const key = entityDuplicateKey(lead.company, lead.country);
      const group = leadGroups.get(key) || [];
      group.push(lead);
      leadGroups.set(key, group);
    }
    const leadIds = new Set(leads.map((lead) => lead.id));
    const linkedCustomerIds = new Set(leads.map((lead) => lead.convertedCustomerId).filter(Boolean));
    const ownerCustomers = new Set(store.customers.filter((customer) => customer.ownerId === id
      && customer.teamId === member.teamId).map((customer) => customer.id));
    const activities = new Set(store.leadActivities.filter((activity) => leadIds.has(activity.leadId)
      && activity.operatorId === id && activity.type !== "system"
      && activity.content.trim().length >= 10 && businessDate(activity.createdAt).startsWith(monthPrefix))
      .map((activity) => activity.leadId));
    const customerContacts = new Set(store.customerActivities.filter((activity) =>
      linkedCustomerIds.has(activity.customerId) && ownerCustomers.has(activity.customerId)
      && activity.operatorId === id && activity.type !== "note"
      && activity.content.trim().length >= 10 && businessDate(activity.createdAt).startsWith(monthPrefix))
      .map((activity) => activity.customerId));
    const candidateContacts = [...leadGroups.values()].filter((group) => group.some((lead) => activities.has(lead.id)
      || Boolean(lead.convertedCustomerId && customerContacts.has(lead.convertedCustomerId)))).length;
    // 已核实回复 = 同一客户本月既有我方出站、也有客户入站的 WhatsApp 消息（双向证据），与月度 61 家端点口径一致
    const monthWhatsApp = store.whatsappMessages.filter((message) =>
      linkedCustomerIds.has(message.customerId) && ownerCustomers.has(message.customerId)
      && businessDate(message.createdAt).startsWith(monthPrefix));
    const inboundCustomers = new Set(monthWhatsApp.filter((message) => message.direction === "inbound").map((message) => message.customerId));
    const outboundCustomers = new Set(monthWhatsApp.filter((message) => message.direction === "outbound").map((message) => message.customerId));
    const verifiedReplies = [...leadGroups.values()].filter((group) => group.some((lead) => Boolean(lead.convertedCustomerId)
      && inboundCustomers.has(lead.convertedCustomerId) && outboundCustomers.has(lead.convertedCustomerId))).length;
    const todos = store.todos.filter((task) => task.ownerId === id && task.teamId === member.teamId && !task.cancelledAt);
    const plans = store.planTasks.filter((task) => task.ownerId === id && task.teamId === member.teamId && task.status !== "cancelled");
    const todayTodos = todos.filter((task) => dueDate(task.dueAt) === today);
    const todayPlans = plans.filter((task) => dueDate(task.dueAt) === today);
    const monthTodos = todos.filter((task) => dueDate(task.dueAt).startsWith(monthPrefix));
    const monthPlans = plans.filter((task) => dueDate(task.dueAt).startsWith(monthPrefix));
    const wonDeals = store.deals.filter((deal) => deal.ownerId === id && deal.teamId === member.teamId
      && deal.stage === "成交" && businessDate(deal.closedAt || deal.stageChangedAt).startsWith(monthPrefix));
    return {
      ownerId: id, owner: member.name, todayTasks: todayTodos.length + todayPlans.length,
      todayCompleted: todayTodos.filter((task) => task.done).length + todayPlans.filter((task) => task.status === "done").length,
      monthTasks: monthTodos.length + monthPlans.length,
      monthCompleted: monthTodos.filter((task) => task.done).length + monthPlans.filter((task) => task.status === "done").length,
      overdueTasks: todos.filter((task) => !task.done && dueDate(task.dueAt) && dueDate(task.dueAt) < today).length
        + plans.filter((task) => task.status !== "done" && dueDate(task.dueAt) && dueDate(task.dueAt) < today).length,
      submittedToday: store.dailyReports.some((report) => report.ownerId === id && report.teamId === member.teamId && report.reportDate === today),
      newLeads: leadGroups.size, communicationCandidates: candidateContacts,
      verifiedWhatsAppReplies: verifiedReplies, target: GOAL,
      verifiedProgressPercent: Math.min(100, Math.round(verifiedReplies / GOAL * 100)),
      followUps: store.customerActivities.filter((activity) => activity.operatorId === id
        && ownerCustomers.has(activity.customerId) && businessDate(activity.createdAt).startsWith(monthPrefix)).length,
      wonDeals: wonDeals.length, wonAmounts: moneyByCurrency(wonDeals)
    };
  }).sort((a, b) => b.verifiedWhatsAppReplies - a.verifiedWhatsAppReplies || b.wonDeals - a.wonDeals || a.owner.localeCompare(b.owner));
  return {
    month, today, timezone: ZONE, target: GOAL, scope: "本团队授权业务员", rows,
    definitions: {
      candidates: "本月新增线索存在非系统跟进或转客户后的沟通记录，仍须人工核实，不等于有效沟通考核达标",
      verified: "仅计算本月新增并已转客户的线索中，同一客户本月既有我方发出、又有客户回复的双向 WhatsApp 沟通。电话、邮件和面谈需人工审核，不能仅凭录入算完成",
      sales: "按本月成交商机计金额、各币种分别显示，非财务回款",
      tasks: "按计划到期日汇总待办与计划任务，完成率按当前状态，不代表按时完成"
    }
  };
}
