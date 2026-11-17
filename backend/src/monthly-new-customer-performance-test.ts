import assert from "node:assert/strict";
import { calculateMonthlyNewCustomerPerformance } from "./monthly-new-customer-performance.js";

const asOf = "2026-12-01T00:00:00.000Z";
const month = "2026-11";
const customers = Array.from({ length: 65 }, (_, index) => ({
  id: "customer-" + (index + 1),
  company: "New customer " + (index + 1),
  ownerId: "alice",
  teamId: "team-a",
  poolStatus: "owned" as const
}));

type Message = { customerId: string; direction: "inbound" | "outbound"; createdAt: string };
type Activity = {
  customerId: string;
  type: "call" | "meeting" | "email" | "wechat" | "whatsapp" | "note";
  operatorId: string;
  content: string;
  createdAt: string;
};

const pairs: Message[] = customers.slice(0, 61).flatMap((customer) => [
  { customerId: customer.id, direction: "outbound", createdAt: "2026-11-02T10:00:00Z" },
  { customerId: customer.id, direction: "inbound", createdAt: "2026-11-02T11:00:00Z" }
]);
const report = (options: {
  subset?: typeof customers; messages?: Message[]; activities?: Activity[]; ownerIds?: string[];
  target?: number; reportMonth?: string;
} = {}) => calculateMonthlyNewCustomerPerformance({
  month: options.reportMonth || month,
  customers: options.subset || customers,
  whatsappMessages: options.messages || pairs,
  activities: options.activities || [],
  ownerIds: options.ownerIds,
  target: options.target,
  asOf
});

const all61 = report();
assert.equal(all61.members.length, 1);
assert.equal(all61.members[0].qualifiedCount, 61);
assert.equal(all61.members[0].independentlyVerifiedCount, 61);
assert.equal(all61.members[0].needsReviewCount, 0);
assert.equal(all61.members[0].remaining, 0);
assert.equal(all61.members[0].status, "met");
assert.equal(new Set(all61.members[0].customers.map((item) => item.customerId)).size, 61);

// Hundreds of records for one company must count as exactly ONE distinct customer.
const repeated = report({ messages: [
  ...pairs,
  ...Array.from({ length: 100 }, () => ({
    customerId: "customer-1", direction: "outbound" as const, createdAt: "2026-11-06T14:00:00Z"
  }))
]});
assert.equal(repeated.members[0].qualifiedCount, 61);

// A one-way message or bare note is NOT effective communication.
const oneWay = report({
  subset: [customers[63]],
  messages: [{ customerId: "customer-64", direction: "outbound", createdAt: "2026-11-04T10:00:00Z" }],
  activities: [{ customerId: "customer-64", type: "note", operatorId: "alice",
    content: "写了很多条跟进备忘，但客户从未实际回复", createdAt: "2026-11-04T11:00:00Z" }]
});
assert.equal(oneWay.members[0].qualifiedCount, 0);
assert.equal(oneWay.members[0].status, "below_target");

// Previously engaged customers are not "new" in later months.
const historical = report({
  subset: [customers[61]],
  messages: [
    { customerId: "customer-62", direction: "outbound", createdAt: "2026-10-31T22:00:00Z" },
    { customerId: "customer-62", direction: "inbound", createdAt: "2026-10-31T23:00:00Z" },
    { customerId: "customer-62", direction: "inbound", createdAt: "2026-11-02T10:00:00Z" }
  ]
});
assert.equal(historical.members[0].qualifiedCount, 0);

// Cross-month two-way exchange becomes effective on the date of its first reply.
const acrossBoundary = report({
  subset: [customers[61]],
  messages: [
    { customerId: "customer-62", direction: "outbound", createdAt: "2026-10-31T23:59:00Z" },
    { customerId: "customer-62", direction: "inbound", createdAt: "2026-11-01T00:01:00Z" }
  ]
});
assert.equal(acrossBoundary.members[0].qualifiedCount, 1);
assert.equal(acrossBoundary.members[0].customers[0].firstEffectiveAt, "2026-11-01T00:01:00.000Z");

// Call/meeting records need substantive details, remain pending a manager's audit.
const call: Activity = {
  customerId: "customer-63", type: "call", operatorId: "alice",
  content: "与客户通话确认本月采购数量及报价细节", createdAt: "2026-11-05T10:00:00Z"
};
const provisional = report({
  subset: [...customers.slice(0, 60), customers[62]],
  messages: pairs.filter((item) => Number(item.customerId.split("-")[1]) <= 60),
  activities: [call]
});
assert.equal(provisional.members[0].qualifiedCount, 61);
assert.equal(provisional.members[0].independentlyVerifiedCount, 60);
assert.equal(provisional.members[0].needsReviewCount, 1);
assert.equal(provisional.members[0].status, "needs_review");

// A failed call, forged operator, or unacknowledged email must not count.
const ignored = report({
  subset: [customers[62]],
  messages: [],
  activities: [
    { ...call, content: "客户电话无人接听，未有效沟通" },
    { ...call, operatorId: "bob" },
    { ...call, type: "email", content: "已发送开发邮件，期待客户回复" }
  ]
});
assert.equal(ignored.members[0].qualifiedCount, 0);

// Caller access scope is authoritative even if messages for another team are supplied.
const noScopeLeak = report({
  subset: [{ ...customers[62], ownerId: "bob", teamId: "team-b" }],
  messages: pairs,
  ownerIds: ["bob", "manager"]
});
assert.equal(noScopeLeak.members.find((member) => member.ownerId === "bob")?.qualifiedCount, 0);
assert.equal(noScopeLeak.members.find((member) => member.ownerId === "manager")?.qualifiedCount, 0);

// Future-dated events and invalid month values cannot inflate metrics.
const future = report({
  subset: [customers[62]],
  messages: [
    { customerId: "customer-63", direction: "inbound", createdAt: "2026-12-02T00:00:00Z" },
    { customerId: "customer-63", direction: "outbound", createdAt: "2026-12-02T01:00:00Z" }
  ]
});
assert.equal(future.members[0].qualifiedCount, 0);
assert.throws(() => report({ reportMonth: "2026-13" }), /month must be/);
assert.throws(() => report({ target: 0 }), /positive integer/);

console.log(JSON.stringify({
  ok: true, target61AndDedup: true, crossMonthFirstReply: true, historicalNotNew: true,
  noNotesOrUnanswered: true, manualReviewRequired: true, noScopeLeak: true, futureRejected: true
}));
