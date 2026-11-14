import assert from "node:assert/strict";
import {
  applyLeadAssignment,
  assignableMembersFor,
  canAssignLead,
  canAssignLeads,
  leadAssignmentRows
} from "./lead-assignment.js";
import type { Lead, SessionUser, User } from "./types.js";

const manager = {
  id: "manager_1",
  name: "Manager",
  role: "manager",
  teamId: "team_a",
  authVersion: 1
} as SessionUser;
const sales = {
  id: "sales_1", name: "Sales", role: "sales",
  teamId: "team_a", authVersion: 1
} as SessionUser;
const otherManager = {
  ...manager, id: "manager_b", teamId: "team_b"
} as SessionUser;
const iamNoGrant = {
  ...manager, iamPermissions: {}
} as SessionUser;
const iamAllowed = {
  ...manager, iamPermissions: { "lead.update": ["org_unit"] }
} as SessionUser;
const lead = {
  id: "lead_1", company: "Example Inc", country: "USA",
  ownerId: "manager_1", teamId: "team_a", status: "new"
} as unknown as Lead;
const users = [
  { id: "manager_1", name: "Manager", email: "manager@example.test", role: "manager", teamId: "team_a", status: "active" },
  { id: "sales_1", name: "Sales", email: "sales@example.test", role: "sales", teamId: "team_a", status: "active" },
  { id: "disabled", name: "Disabled", email: "disabled@example.test", role: "sales", teamId: "team_a", status: "disabled" },
  { id: "other", name: "Other", email: "other@example.test", role: "sales", teamId: "team_b", status: "active" },
  { id: "platform", name: "Platform", email: "platform@example.test", role: "super_admin", teamId: "team_a", status: "active" }
] as User[];

assert.equal(canAssignLeads(manager), true);
assert.equal(canAssignLeads(sales), false);
assert.equal(canAssignLeads(otherManager), true);
assert.equal(canAssignLeads(iamNoGrant), false);
assert.equal(canAssignLeads(iamAllowed), true);
assert.equal(canAssignLeads({ ...manager, role: "super_admin" }), false);
assert.equal(canAssignLead(manager, lead), true);
assert.equal(canAssignLead(sales, lead), false);
assert.equal(canAssignLead(otherManager, lead), false);
assert.equal(canAssignLead(iamNoGrant, lead), false);
assert.deepEqual(assignableMembersFor(users, manager).map((member) => member.id),
  ["manager_1", "sales_1"]);
assert.deepEqual(assignableMembersFor(users, sales), []);
assert.equal(leadAssignmentRows([lead], users, manager).length, 1);
assert.deepEqual(leadAssignmentRows([lead], users, sales), []);

const when = "2026-11-14T00:00:00.000Z";
assert.deepEqual(applyLeadAssignment({
  lead, toOwnerId: "sales_1", actorId: manager.id, note: "Assign to sales", now: when
}), { changed: true });
assert.equal(lead.ownerId, "sales_1");
assert.equal(lead.assignedBy, "manager_1");
assert.equal(lead.assignmentFrom, "manager_1");
assert.equal(lead.assignedAt, when);
assert.equal(lead.assignmentNote, "Assign to sales");
assert.equal(canAssignLead(manager, lead), true);
assert.equal(canAssignLead(otherManager, lead), false);
assert.deepEqual(applyLeadAssignment({
  lead, toOwnerId: "sales_1", actorId: manager.id, note: "No-op", now: when
}), { changed: false });
assert.equal(lead.assignmentNote, "Assign to sales");

lead.deletedAt = when;
assert.equal(canAssignLead(manager, lead), false);
assert.deepEqual(leadAssignmentRows([lead], users, manager), []);
console.log("lead-assignment-test: all assertions passed");
