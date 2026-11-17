const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const scope = process.argv[2];
if (!["backend", "whatsapp-plugin"].includes(scope)) throw Error("scope must be backend or whatsapp-plugin");
const requireForWorkspace = createRequire(resolve(scope, "package.json"));
const { z } = requireForWorkspace("zod");
if (typeof global.gc === "function") global.gc();
const before = process.memoryUsage();
const item = "invalid-value-123456";
const count = 115000;
const items = Array(count).fill(item);
const bodyBytes = Buffer.byteLength(JSON.stringify({ items }));
if (bodyBytes > 3 * 1024 * 1024) throw Error("request proxy exceeds API limit");
const schema = z.object({ items: z.array(z.string().max(4)).max(125000) });
const t0 = performance.now();
const outcome = schema.safeParse({ items });
const elapsedMs = Math.round(performance.now() - t0);
const after = process.memoryUsage();
const stats = {
  scope,
  schemaVersion: requireForWorkspace("zod/package.json").version,
  bodyBytes,
  count,
  failedAsExpected: !outcome.success,
  issues: outcome.success ? 0 : outcome.error.issues.length,
  elapsedMs,
  heapGrowthMb: Math.round((after.heapUsed - before.heapUsed) / 1048576),
  peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024)
};
console.log(JSON.stringify(stats));
if (outcome.success || stats.issues !== count || stats.peakRssMb > 500 || elapsedMs > 30000) {
  process.exitCode = 1;
}