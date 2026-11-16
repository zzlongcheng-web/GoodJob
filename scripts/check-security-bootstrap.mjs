#!/usr/bin/env node
// Static regression guard: reject production credential seeding, hidden login autofill,
// insecure API-doc defaults, or implicit third-party SVN source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (file) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const store = read("backend/src/mysql-store.ts");
const events = read("frontend/src/modules/events.ts");
const client = read("frontend/src/prototype-api.ts");
const env = read(".env.example");
const compose = read("deploy/docker-compose/compose.yml");
const update = read("deploy/docker-compose/update-from-svn.sh");
const install = read("deploy/docker-compose/install-docker-ubuntu.sh");
const configure = read("deploy/docker-compose/configure.sh");
const installer = read("deploy/docker-compose/install.sh");
assert.doesNotMatch(store, /ensureBuiltInSuperAdmin|BUILT_IN_SUPERADMIN|seededBuiltInSuperadmin|u_superadmin/);
assert.doesNotMatch(events, /prefillLoginCredentials|DEFAULT_LOGIN_(EMAIL|PASSWORD)/);
assert.doesNotMatch(client, /prefillLoginCredentials/);
assert.match(env, /^ENABLE_API_DOCS=false$/m);
assert.match(compose, /ENABLE_API_DOCS: \$\{ENABLE_API_DOCS:-false\}/);
assert.doesNotMatch(update + install, /svn:\/\/gitee\.com\/sendoh-huang\/good-job-private/);
assert.match(update, /SVN_URL="\$\{GOODJOB_SVN_URL:-\}"/);
assert.match(update, /\[\[ -n "\$SVN_URL" \]\]/);
assert.match(configure, /^ENABLE_API_DOCS=false$/m);
assert.doesNotMatch(configure, /DEFAULT_INITIAL_ADMIN_EMAIL|beta-admin-|admin_credentials\.tsv/);
assert.doesNotMatch(installer, /provision-beta-admins|预置 50 个团队管理员/);
assert.doesNotMatch(compose, /admin_credentials\.tsv|\s- admin_credentials\s/);
console.log("Security bootstrap regression check: PASS (source defaults only; not a database or production runtime audit)");
