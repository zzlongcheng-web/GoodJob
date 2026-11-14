import type { Lead, SessionUser, User } from "./types.js";
import { canSeeOwner, isPlatformIdentity } from "./auth.js";

/**
 * Lead assignment is a team-management action, not a general sales permission.
 * IAM-resolved users must have a scoped lead update grant as well as a
 * manager/admin role; legacy roles retain their existing team boundary.
 */
export function canAssignLeads(user: SessionUser | undefined): boolean {
  if (!user || isPlatformIdentity(user)) return false;
  if (user.role !== "manager" && user.role !== "admin") return false;
  if (user.iamPermissions) {
    const scopes = user.iamPermissions["lead.update"] || [];
    return scopes.some((scope) =>
      scope === "self" || scope === "org_unit" ||
      scope === "org_subtree" || scope === "tenant"
    );
  }
  return true;
}

export function canAssignLead(user: SessionUser, lead: Lead): boolean {
  return canAssignLeads(user)
    && !lead.deletedAt
    && lead.teamId === user.teamId
    && canSeeOwner(user, lead.ownerId, lead.teamId)
    && (lead.ownerId === user.id || lead.assignedBy === user.id);
}

export function assignableMembersFor(users: User[], user: SessionUser) {
  if (!canAssignLeads(user)) return [];
  return users
    .filter((member) =>
      member.teamId === user.teamId
      && member.status === "active"
      && member.role !== "super_admin"
    )
    .map(({ id, name, email, role, teamId }) => ({
      id, name, email, role, teamId
    }));
}

export function leadAssignmentRows(
  leads: Lead[],
  users: User[],
  user: SessionUser
) {
  if (!canAssignLeads(user)) return [];
  const names = new Map(users.map((member) => [member.id, member.name]));
  return leads
    .filter((lead) => !lead.deletedAt && canAssignLead(user, lead))
    .map((lead) => ({
      leadId: lead.id,
      company: lead.company,
      country: lead.country,
      ownerId: lead.ownerId,
      ownerName: names.get(lead.ownerId) || "",
      assignedBy: lead.assignedBy || "",
      assignedByName: names.get(lead.assignedBy || "") || "",
      assignedAt: lead.assignedAt || "",
      assignmentFrom: lead.assignmentFrom || "",
      assignmentFromName: names.get(lead.assignmentFrom || "") || "",
      assignmentNote: lead.assignmentNote || "",
      teamId: lead.teamId
    }));
}

export function applyLeadAssignment(input: {
  lead: Lead;
  toOwnerId: string;
  actorId: string;
  note: string;
  now: string;
}): { changed: boolean } {
  const { lead, toOwnerId, actorId, note, now } = input;
  if (lead.ownerId === toOwnerId) return { changed: false };
  const previousOwnerId = lead.ownerId;
  lead.ownerId = toOwnerId;
  lead.assignedBy = actorId;
  lead.assignedAt = now;
  lead.assignmentFrom = previousOwnerId;
  lead.assignmentNote = note;
  return { changed: true };
}
