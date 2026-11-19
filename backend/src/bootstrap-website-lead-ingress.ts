/** Idempotent first-boot setup. Never prints signing or encryption secrets. */
import { randomBytes } from "node:crypto";
import {
  readWebsiteLeadIngressSettings,
  writeWebsiteLeadIngressSettings
} from "./website-lead-ingress-settings.js";

const existing = readWebsiteLeadIngressSettings();
if (existing.enabled) {
  if (!existing.current || !existing.ownerId) throw new Error("Website lead ingress configuration is incomplete.");
  console.log(JSON.stringify({ configured: true, reused: true, currentKeyId: existing.current.id }));
} else if (existing.current || existing.previous || existing.ownerId) {
  throw new Error("Website lead ingress was explicitly disabled; refusing to overwrite operator configuration.");
} else {
  // Platform owner is a placeholder and has no lead.create permission.
  // The public endpoint rejects inbound leads until an authorized business
  // owner is configured using configure-website-lead-ingress.ts.
  const result = writeWebsiteLeadIngressSettings({
    schemaVersion: 1,
    enabled: true,
    ownerId: "u_initial_super_admin",
    current: { id: `firstboot_${randomBytes(6).toString("hex")}`, secret: randomBytes(48).toString("hex") },
    previous: null
  });
  console.log(JSON.stringify({ configured: true, reused: false, currentKeyId: result.currentKeyId }));
}
