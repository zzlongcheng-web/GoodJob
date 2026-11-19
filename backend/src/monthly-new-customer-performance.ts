/**
 * 61 distinct newly engaged customers per Asia/Shanghai calendar month.
 *
 * "New" means the customer's FIRST qualifying two-way communication, not the
 * number of follow-up rows and not necessarily the CRM record creation date.
 * Historical customers with qualifying communication in earlier months do not
 * count again. Customer ownership is taken from the caller-scoped snapshot.
 *
 * WhatsApp counts only once both inbound and outbound messages exist. Notes and
 * outbound-only contacts never count. Manually logged calls/meetings and
 * explicitly acknowledged replies can be counted provisionally, but their
 * evidence must be audited by a manager before reporting verified attainment.
 */
import type { Customer, CustomerActivity, WhatsAppMessage } from "./types.js";

export const MONTHLY_NEW_CUSTOMER_TARGET = 61;
export type EffectiveCommunicationEvidence = "two_way_whatsapp" | "manual_record";

export interface MonthlyCustomerEvidence {
  customerId: string;
  company: string;
  ownerId: string;
  teamId: string;
  firstEffectiveAt: string;
  channel: CustomerActivity["type"] | "whatsapp";
  evidence: EffectiveCommunicationEvidence;
}

export interface MonthlyEmployeePerformance {
  ownerId: string;
  target: number;
  qualifiedCount: number;
  independentlyVerifiedCount: number;
  needsReviewCount: number;
  remaining: number;
  progressPercent: number;
  status: "below_target" | "needs_review" | "met";
  customers: MonthlyCustomerEvidence[];
}

type CustomerRecord = Pick<Customer, "id" | "company" | "ownerId" | "teamId" | "poolStatus">;
type ActivityRecord = Pick<CustomerActivity, "customerId" | "type" | "content" | "operatorId" | "createdAt">;
type MessageRecord = Pick<WhatsAppMessage, "customerId" | "direction" | "createdAt">;

export interface MonthlyNewCustomerInput {
  month: string;
  customers: CustomerRecord[]; // ALREADY filtered by the logged-in user's CRM access scope
  activities: ActivityRecord[];
  whatsappMessages: MessageRecord[];
  ownerIds?: string[];
  target?: number;
  asOf?: string;
}

const PERFORMANCE_TIMEZONE = "Asia/Shanghai" as const;
const monthPattern = /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/u;
const monthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PERFORMANCE_TIMEZONE, year: "numeric", month: "2-digit"
});

export const PERFORMANCE_TIME_ZONE = PERFORMANCE_TIMEZONE;

/** Current KPI month (YYYY-MM) in Beijing time; never derived from UTC or the server's local zone. */
export function currentPerformanceMonth(now: Date = new Date()): string {
  return beijingMonth(now.getTime());
}

function beijingMonth(at: number): string {
  const parts = monthFormatter.formatToParts(new Date(at));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new RangeError("invalid performance timestamp");
  return `${year}-${month}`;
}
const noContact = /未接通|无人接听|未回复|未联系|待联系|呼叫失败|拨号失败|拒接|未沟通|期待.{0,12}回复|等待.{0,12}回复|待.{0,12}回复|尚未.{0,12}回复|no answer|no reply|no response|awaiting reply|waiting for reply|voicemail|missed call/iu;
const meaningfulContext = /客户|采购|报价|价格|订单|样品|通话|会议|沟通|回复|确认|customer|buyer|client|meeting|spoke|discussed/iu;
const customerReply = /客户.{0,10}(?:回复|确认|反馈|答复|回应)|对方.{0,10}(?:回复|确认|反馈)|(?:customer|buyer|client).{0,15}(?:replied|responded|confirmed)/iu;

function validMoment(date: string, asOf: number): number | null {
  const ms = Date.parse(date);
  return Number.isFinite(ms) && ms <= asOf ? ms : null;
}

function isProvisionalEffective(activity: ActivityRecord): boolean {
  const content = activity.content.trim();
  if (content.length < 12 || noContact.test(content)) return false;
  if (activity.type === "call" || activity.type === "meeting") return meaningfulContext.test(content);
  if (activity.type === "email" || activity.type === "wechat" || activity.type === "whatsapp") {
    return customerReply.test(content);
  }
  return false; // note never qualifies
}

export function calculateMonthlyNewCustomerPerformance(input: MonthlyNewCustomerInput) {
  if (!monthPattern.test(input.month)) throw new RangeError("month must be YYYY-MM");
  const target = input.target ?? MONTHLY_NEW_CUSTOMER_TARGET;
  if (!Number.isInteger(target) || target < 1) throw new RangeError("target must be a positive integer");
  const asOf = input.asOf ? Date.parse(input.asOf) : Date.now();
  if (!Number.isFinite(asOf)) throw new RangeError("asOf must be a valid ISO timestamp");

  const allowedCustomers = new Map(
    input.customers
      .filter((customer) => customer.poolStatus !== "public" && customer.ownerId && customer.teamId)
      .map((customer) => [customer.id, customer])
  );
  const firstByCustomer = new Map<string, { at: number; channel: MonthlyCustomerEvidence["channel"]; evidence: EffectiveCommunicationEvidence }>();

  function propose(customerId: string, at: number, channel: MonthlyCustomerEvidence["channel"], evidence: EffectiveCommunicationEvidence) {
    if (!allowedCustomers.has(customerId)) return;
    const previous = firstByCustomer.get(customerId);
    if (!previous || at < previous.at || (at === previous.at && evidence === "two_way_whatsapp")) {
      firstByCustomer.set(customerId, { at, channel, evidence });
    }
  }

  // The first moment a WhatsApp dialogue becomes two-way is the later of its
  // earliest inbound and outbound messages, even across calendar months.
  const directions = new Map<string, { inbound?: number; outbound?: number }>();
  for (const message of input.whatsappMessages) {
    if (!allowedCustomers.has(message.customerId)) continue;
    const at = validMoment(message.createdAt, asOf);
    if (at === null) continue;
    const pair = directions.get(message.customerId) || {};
    const previous = pair[message.direction];
    if (previous === undefined || at < previous) pair[message.direction] = at;
    directions.set(message.customerId, pair);
  }
  for (const [customerId, pair] of directions) {
    if (pair.inbound !== undefined && pair.outbound !== undefined) {
      propose(customerId, Math.max(pair.inbound, pair.outbound), "whatsapp", "two_way_whatsapp");
    }
  }

  for (const activity of input.activities) {
    const customer = allowedCustomers.get(activity.customerId);
    if (!customer || customer.ownerId !== activity.operatorId || !isProvisionalEffective(activity)) continue;
    const at = validMoment(activity.createdAt, asOf);
    if (at !== null) propose(activity.customerId, at, activity.type, "manual_record");
  }

  const byOwner = new Map<string, MonthlyCustomerEvidence[]>();
  const owners = new Set(input.ownerIds || []);
  for (const customer of allowedCustomers.values()) owners.add(customer.ownerId);
  for (const [customerId, first] of firstByCustomer) {
    const date = new Date(first.at).toISOString();
    if (beijingMonth(first.at) !== input.month) continue;
    const customer = allowedCustomers.get(customerId)!;
    const result: MonthlyCustomerEvidence = {
      customerId, company: customer.company, ownerId: customer.ownerId, teamId: customer.teamId,
      firstEffectiveAt: date, channel: first.channel, evidence: first.evidence
    };
    byOwner.set(customer.ownerId, [...(byOwner.get(customer.ownerId) || []), result]);
  }

  const members: MonthlyEmployeePerformance[] = [...owners].sort().map((ownerId) => {
    const customers = (byOwner.get(ownerId) || []).sort((a, b) =>
      a.firstEffectiveAt.localeCompare(b.firstEffectiveAt) || a.customerId.localeCompare(b.customerId));
    const independentlyVerifiedCount = customers.filter((entry) => entry.evidence === "two_way_whatsapp").length;
    const needsReviewCount = customers.length - independentlyVerifiedCount;
    const qualifiedCount = customers.length;
    return {
      ownerId, target, qualifiedCount, independentlyVerifiedCount, needsReviewCount,
      remaining: Math.max(target - qualifiedCount, 0),
      progressPercent: Math.min(100, Math.round((qualifiedCount / target) * 100)),
      status: qualifiedCount < target ? "below_target"
        : independentlyVerifiedCount < target ? "needs_review" : "met",
      customers
    };
  });

  return {
    month: input.month,
    timezone: PERFORMANCE_TIMEZONE,
    target,
    definition: "首次有效沟通；去重客户ID；WhatsApp双向消息为独立证据，其余明确沟通纪要需主管复核",
    members
  };
}
