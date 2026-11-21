import { createHash, randomBytes } from "node:crypto";
import { entityDuplicateKey } from "./entity-duplicates.js";

/** External intake credentials deliberately have a different format from sessions and runners. */
export const INTAKE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export function newIntakeToken() {
  return "gj_intake_" + randomBytes(32).toString("base64url");
}
export function intakeTokenDigest(token: string): string | null {
  return /^gj_intake_[A-Za-z0-9_-]{43}$/u.test(token)
    ? createHash("sha256").update(token).digest("hex")
    : null;
}
export interface IntakeIdentity {
  id: string;
  teamId: string;
  authVersion?: number;
  status: string;
  expiresAt?: string;
}
export interface IntakeGrant {
  ownerId: string;
  teamId: string;
  authVersion: number;
  expiresAt: number;
  revokedAt: number | null;
}
export function intakeGrantValid(grant: IntakeGrant, actor: IntakeIdentity, now = Date.now()) {
  const accountExpiry = actor.expiresAt?.trim();
  return actor.status === "active" && !!actor.teamId
    && grant.ownerId === actor.id && grant.teamId === actor.teamId
    && grant.authVersion === (actor.authVersion || 1)
    && grant.revokedAt === null && Number.isFinite(grant.expiresAt) && grant.expiresAt > now
    && (!accountExpiry || Date.parse(accountExpiry) > now);
}
export interface IntakeFields {
  company: string;
  country: string;
  companyFullName?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  website?: string;
}
type Existing = IntakeFields & { teamId: string };
type MatchReason = "company_country" | "full_name_country" | "email" | "telephone";
const normal = (v?: string) => (v || "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
function emailKey(v?: string) {
  const key = normal(v);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(key) ? key : "";
}
function telephoneKey(v?: string) {
  const key = (v || "").normalize("NFKC").trim().replace(/[\s().-]/gu, "").replace(/^00/u, "+");
  // Never guess a country code or silently strip an extension.
  return /^\+[1-9]\d{6,14}$/u.test(key) ? key : "";
}
/** A match is intentionally a block, not an instruction to reveal or merge another owner's customer. */
export function intakeDuplicateReasons(input: IntakeFields, existing: readonly Existing[], teamId: string): MatchReason[] {
  if (!teamId) return [];
  const result = new Set<MatchReason>();
  const companyNames = [normal(input.company), normal(input.companyFullName)].filter(Boolean);
  const inputEmail = emailKey(input.email);
  const numbers = [telephoneKey(input.phone), telephoneKey(input.whatsapp)].filter(Boolean);
  for (const customer of existing) {
    if (customer.teamId !== teamId) continue;
    if (normal(input.company) && entityDuplicateKey(input.company, input.country) === entityDuplicateKey(customer.company, customer.country)) result.add("company_country");
    const knownCountry = normal(input.country);
    if (knownCountry && !["未知", "unknown"].includes(knownCountry) && knownCountry === normal(customer.country)
        && [normal(customer.company), normal(customer.companyFullName)].some(name => !!name && companyNames.includes(name))) result.add("full_name_country");
    if (inputEmail && emailKey(customer.email) === inputEmail) result.add("email");
    if ([telephoneKey(customer.phone), telephoneKey(customer.whatsapp)].some(number => !!number && numbers.includes(number))) result.add("telephone");
  }
  return [...result];
}
