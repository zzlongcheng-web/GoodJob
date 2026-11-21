import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasIamScope, isPlatformIdentity, publicUser, requireAuth } from "../auth.js";
import { asyncRoute, enforceIamTenantPermission } from "../server-core.js";
import { getStore } from "../store.js";
import type { Customer } from "../types.js";
import { getExternalIntakeRepository, type IntakeTokenRecord } from "../external-customer-intake-repository.js";
import { intakeGrantValid } from "../external-customer-intake-policy.js";

const base = "/api/external-customer-intake";
const enabled = () => process.env.EXTERNAL_CUSTOMER_INTAKE_ENABLED === "true";
const intake = z.object({
  company: z.string().trim().min(1).max(120),
  country: z.string().trim().min(1).max(60).refine(s => !["未知","unknown","n/a","待维护"].includes(s.toLowerCase()), "国家需明确"),
  companyFullName: z.string().trim().max(200).default(""),
  contact: z.string().trim().max(80).default(""),
  email: z.union([z.literal(""),z.string().trim().email().max(160)]).default(""),
  phone: z.string().trim().max(40).default(""),
  whatsapp: z.string().trim().regex(/^\+[1-9]\d{6,14}$/u).or(z.literal("")).default(""),
  wechat: z.string().trim().max(100).default(""),
  website: z.string().trim().max(200).default(""),
  source: z.string().trim().max(120).default("WorkBuddy"),
  otherNotes: z.string().trim().max(2000).default("")
}).strict();
type Input = z.infer<typeof intake>;

function usableRepository(res: Response, requireEnabled = true) {
  res.setHeader("Cache-Control", "no-store");
  if ((requireEnabled && !enabled()) || getStore().mode !== "mysql") {
    res.status(503).json({ status:"unavailable", message:"外部客户录入尚未启用" });
    return null;
  }
  const repo = getExternalIntakeRepository();
  if (!repo) res.status(503).json({ status:"unavailable", message:"授权存储暂不可用" });
  return repo || null;
}
function isTenantActor(req: Request) {
  return Boolean(req.user?.teamId && req.user.role !== "super_admin" && !isPlatformIdentity(req.user));
}
async function canIntake(req: Request, res: Response) {
  if (!isTenantActor(req)) {
    res.status(403).json({ status:"forbidden", message:"仅公司员工可使用客户录入授权" });
    return false;
  }
  for (const code of ["customer.read", "customer.create"]) {
    let passed = false;
    await enforceIamTenantPermission(req, res, () => { passed = true; }, code);
    if (!passed) return false;
  }
  if (!req.user!.iamDataScope?.tenantWide && !req.user!.iamDataScope?.ownerIds.includes(req.user!.id)) {
    res.status(403).json({ status:"forbidden", message:"当前权限不能创建归属本人的客户" });
    return false;
  }
  return true;
}
async function authenticateIntake(req: Request, res: Response, record: IntakeTokenRecord | null) {
  const store = getStore();
  const user = record && store.users.find(u => u.id === record.ownerId);
  if (!record || !user || !intakeGrantValid(record,user)) {
    res.status(401).json({ status:"unauthorized", message:"客户录入授权无效、已撤销或已过期" });
    return false;
  }
  req.user = publicUser(user);
  // Re-query IAM on every invocation; never copy the permissions that existed when issuing the token.
  const session = await store.validateIamSession?.(req.user);
  if (session && !session.valid) {
    res.status(403).json({ status:"forbidden", message:"员工身份已失效" });
    return false;
  }
  const snapshot = await store.getIamCapabilitySnapshot?.(req.user);
  if (snapshot) {
    req.user.iamPermissions = snapshot.permissions;
    req.user.iamSource = snapshot.source;
    req.user.iamRoleNames = snapshot.roleNames;
  }
  return canIntake(req,res);
}
function newCustomer(body: Input, ownerId: string, teamId: string): Customer {
  const fullName = body.companyFullName || body.company;
  return {
    id: "c_" + randomUUID(), ownerId, teamId, company:body.company, country:body.country,
    contact:body.contact || "待维护", phone:body.phone, email:body.email, whatsapp:body.whatsapp,
    wechat:body.wechat, website:body.website, source:body.source || "WorkBuddy", otherNotes:body.otherNotes,
    companyFullName:fullName, billingName:fullName, billingAddress:"", documentContact:"",
    stage:"询盘", amount:0, health:72, grade:"C", lifecycleStatus:"open",
    nextReminder:"明天 10:00", wecomBound:false, defaultPortDischarge:"", defaultIncoterm:"",defaultPaymentTerm:""
  };
}
export function registerExternalCustomerIntakeRoutes(app: Express) {
  // Only an ordinary CRM session may issue or manage grants; intake tokens are deliberately rejected by requireAuth.
  app.post(base + "/tokens", requireAuth, asyncRoute(async (req,res) => {
    const repo = usableRepository(res);
    if (!repo || !await canIntake(req,res)) return;
    const { label } = z.object({ label:z.string().trim().min(1).max(120).default("WorkBuddy") }).strict().parse(req.body || {});
    const actor = req.user!;
    const value = await repo.issue(actor.id, actor.teamId, actor.authVersion || 1, label);
    res.status(201).json({ ...value, message:"授权仅显示一次，有效期30天" });
  }));
  app.get(base + "/tokens", requireAuth, asyncRoute(async (req,res) => {
    const repo = usableRepository(res,false);
    if (!repo) return;
    if (!isTenantActor(req)) { res.status(403).json({message:"无权访问"}); return; }
    const actor = req.user!;
    const admin = hasIamScope(actor,"member.manage",["tenant"]);
    const teamWide = req.query.scope === "team";
    if (teamWide && !admin) { res.status(403).json({message:"无权查看团队授权"}); return; }
    res.json({ enabled:enabled(), tokens:await repo.list(actor.teamId,teamWide ? undefined : actor.id) });
  }));
  app.delete(base + "/tokens/:id", requireAuth, asyncRoute(async (req,res) => {
    const repo = usableRepository(res,false);
    if (!repo) return;
    if (!isTenantActor(req)) { res.status(403).json({message:"无权访问"}); return; }
    const actor = req.user!;
    const id = z.string().uuid().parse(req.params.id);
    const ok = await repo.revoke(id,actor.teamId,actor.id,hasIamScope(actor,"member.manage",["tenant"]));
    res.status(ok ? 200 : 404).json({ok});
  }));

  for (const action of ["check", "create"] as const) {
    app.post(base + "/" + action, asyncRoute(async (req,res) => {
      const repo = usableRepository(res);
      if (!repo) return;
      const match = /^Bearer (gj_intake_[A-Za-z0-9_-]{43})$/u.exec(req.headers.authorization || "");
      const record = match ? await repo.lookup(match[1]) : null;
      if (!await authenticateIntake(req,res,record) || !record) return;
      const body = intake.parse(req.body);
      const audit = await repo.beginUse(record,action);
      if (!audit) { res.status(401).json({status:"unauthorized",message:"客户录入授权已撤销或过期"}); return; }
      const store = getStore();
      const actor = req.user!;
      let outcome: "clear" | "duplicate" | "created" | "failed" = "failed";
      let status = 503;
      let result: Record<string,unknown> = {status:"unavailable",message:"客户录入暂不可用，请稍后重新查重"};
      try {
        if (action === "check") {
          const duplicate = await repo.hasDuplicate(body,actor.teamId,store.customers);
          outcome = duplicate ? "duplicate" : "clear";
          status = 200;
          result = {status:outcome,duplicate};
        } else {
          const customer = newCustomer(body,actor.id,actor.teamId);
          const created = await repo.createCustomer(record,customer,store,audit,async () => {
            const current = store.users.find(u => u.id === actor.id);
            if (!current || !intakeGrantValid(record,current)) return false;
            const fresh = publicUser(current);
            if (fresh.role === "super_admin") return false;
            const session = await store.validateIamSession?.(fresh);
            if (session && !session.valid) return false;
            const snapshot = await store.getIamCapabilitySnapshot?.(fresh);
            if (snapshot) {
              fresh.iamPermissions = snapshot.permissions;
              fresh.iamSource = snapshot.source;
              fresh.iamRoleNames = snapshot.roleNames;
            }
            if (isPlatformIdentity(fresh) || !hasIamScope(fresh,"customer.read",["self","org_unit","org_subtree","tenant"])
                || !hasIamScope(fresh,"customer.create",["self","org_unit","org_subtree","tenant"])) return false;
            const scope = await store.resolveIamDataScope?.(fresh,"customer.create");
            return !scope || scope.tenantWide || scope.ownerIds.includes(fresh.id);
          });
          if (created === "created") {
            status = 201; outcome = "created";
            result = {status:outcome,customerId:customer.id,company:customer.company,country:customer.country};
          } else if (created === "duplicate") {
            status = 409; outcome = "duplicate";
            result = {status:outcome,message:"可能存在重复客户，未新增或覆盖"};
          } else {
            status = 401;
            result = {status:"unauthorized",message:"员工身份或授权已失效"};
          }
        }
      } catch {
        // Fail closed. A retry must check duplicates again; no raw credential or SQL error is returned.
      }
      try {
        if (outcome !== "created") await repo.finishUse(audit,outcome);
      } catch {
        // The started audit record is durable; do not invite a blind retry.
        status = 503; result = {status:"unavailable",message:"审计暂不可用，请稍后重新查重"};
      }
      res.status(status).json(result);
    }));
  }
}
