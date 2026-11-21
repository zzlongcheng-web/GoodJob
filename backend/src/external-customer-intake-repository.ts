import type { Pool, RowDataPacket, ResultSetHeader, PoolConnection } from "mysql2/promise";
import { createHash, randomUUID } from "node:crypto";
import { intakeTokenDigest, newIntakeToken, INTAKE_TOKEN_TTL_MS, intakeDuplicateReasons, intakeGrantValid, type IntakeFields, type IntakeGrant } from "./external-customer-intake-policy.js";
import type { Customer } from "./types.js";
import type { CrmStore } from "./store.js";
type Serialized = <T>(task: () => Promise<T>) => Promise<T>;

export interface IntakeTokenRecord extends IntakeGrant {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}
const tokenFields = "id, label, owner_id, team_id, auth_version, created_at_ms, expires_at_ms, revoked_at_ms, last_used_at_ms";
function fromRow(row: RowDataPacket): IntakeTokenRecord {
  return { id: String(row.id), label: String(row.label), ownerId: String(row.owner_id), teamId: String(row.team_id),
    authVersion: Number(row.auth_version), createdAt: Number(row.created_at_ms), expiresAt: Number(row.expires_at_ms),
    revokedAt: row.revoked_at_ms == null ? null : Number(row.revoked_at_ms), lastUsedAt: row.last_used_at_ms == null ? null : Number(row.last_used_at_ms) };
}
export async function ensureExternalIntakeSchema(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS external_customer_intake_tokens (
    id VARCHAR(64) PRIMARY KEY, digest CHAR(64) NOT NULL UNIQUE, label VARCHAR(120) NOT NULL,
    owner_id VARCHAR(64) NOT NULL, team_id VARCHAR(64) NOT NULL, auth_version INT NOT NULL,
    created_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL,
    revoked_at_ms BIGINT NULL, last_used_at_ms BIGINT NULL,
    INDEX idx_intake_owner (team_id, owner_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS external_customer_intake_audit (
    id VARCHAR(64) PRIMARY KEY, token_id VARCHAR(64) NOT NULL, actor_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL, action VARCHAR(32) NOT NULL, outcome VARCHAR(32) NOT NULL,
    created_at_ms BIGINT NOT NULL, finished_at_ms BIGINT NULL,
    INDEX idx_intake_audit_team (team_id, created_at_ms)
  )`);
}
export class MysqlExternalIntakeRepository {
  constructor(private readonly pool: Pool, private readonly enqueue: Serialized) {}
  private async teamRows(source: Pool | PoolConnection, teamId: string, lock = false) {
    const [rows] = await source.execute<RowDataPacket[]>(
      "SELECT team_id,company,country,company_full_name,email,phone,whatsapp FROM customers WHERE team_id=?" + (lock ? " FOR UPDATE" : ""), [teamId]);
    return rows.map(row => ({
      teamId: String(row.team_id), company: String(row.company || ""), country: String(row.country || ""),
      companyFullName: String(row.company_full_name || ""), email: String(row.email || ""),
      phone: String(row.phone || ""), whatsapp: String(row.whatsapp || "")
    }));
  }
  async hasDuplicate(input: IntakeFields, teamId: string, cached: readonly Customer[]) {
    const rows = await this.teamRows(this.pool,teamId);
    return intakeDuplicateReasons(input,[...cached,...rows],teamId).length > 0;
  }
  /** Same queue as existing API writes. Dedicated INSERT; never call the whole-store replacement path. */
  async createCustomer(record: IntakeTokenRecord, value: Customer, store: CrmStore, auditId: string, stillAllowed: () => Promise<boolean>): Promise<"created" | "duplicate" | "unauthorized"> {
    return this.enqueue(async () => {
      if (value.teamId !== record.teamId || value.ownerId !== record.ownerId || !await stillAllowed()) return "unauthorized";
      if (intakeDuplicateReasons(value,store.customers,value.teamId).length) return "duplicate";
      const connection = await this.pool.getConnection();
      const lockName = "gj_intake_" + createHash("sha256").update(value.teamId).digest("hex").slice(0,48);
      let locked = false, reserved = false, committed = false;
      try {
        const [lockRows] = await connection.execute<RowDataPacket[]>("SELECT GET_LOCK(?,5) AS acquired",[lockName]);
        if (Number(lockRows[0]?.acquired) !== 1) throw new Error("客户录入串行锁暂不可用");
        locked = true;
        await connection.beginTransaction();
        // A revoked/expired token cannot pass a write queued before revocation.
        const [tokens] = await connection.execute<RowDataPacket[]>(`SELECT ${tokenFields} FROM external_customer_intake_tokens WHERE id=? FOR UPDATE`,[record.id]);
        const user = store.users.find(u => u.id === record.ownerId);
        const [users] = await connection.execute<RowDataPacket[]>("SELECT id,team_id,status,auth_version FROM users WHERE id=? FOR UPDATE",[record.ownerId]);
        const dbUser = users[0];
        if (!tokens[0] || !user || !intakeGrantValid(fromRow(tokens[0]),user) || !dbUser
            || dbUser.status !== "active" || dbUser.team_id !== record.teamId || Number(dbUser.auth_version || 1) !== record.authVersion) {
          await connection.rollback(); return "unauthorized";
        }
        const rows = await this.teamRows(connection,value.teamId,true);
        // Check live database plus pending in-process customer writes. Reserve the exact new row before yielding to I/O.
        if (intakeDuplicateReasons(value,[...store.customers,...rows],value.teamId).length) {
          await connection.rollback(); return "duplicate";
        }
        store.customers.unshift(value);
        reserved = true;
        await connection.execute(
          "INSERT INTO customers (id,company,country,contact,whatsapp,wechat,other_notes,owner_id,team_id,stage,amount,health,customer_source,customer_grade,lifecycle_status,next_reminder,wecom_bound,billing_name,company_full_name,billing_address,document_contact,phone,email,website,default_port_discharge,default_incoterm,default_payment_term,pool_status,ownership_version) VALUES (" + Array(29).fill("?").join(",") + ")",
          [value.id,value.company,value.country,value.contact,value.whatsapp || "",value.wechat || "",value.otherNotes || "",value.ownerId,value.teamId,
            value.stage,value.amount,value.health,value.source || "",value.grade || "C",value.lifecycleStatus || "open",value.nextReminder,value.wecomBound,
            value.billingName,value.companyFullName || value.company,value.billingAddress,value.documentContact,value.phone || "",value.email || "",value.website || "",
            value.defaultPortDischarge,value.defaultIncoterm,value.defaultPaymentTerm,"owned",0]);
        await connection.execute("UPDATE external_customer_intake_audit SET outcome='created',finished_at_ms=? WHERE id=? AND outcome='started'",[Date.now(),auditId]);
        await connection.commit();
        committed = true;
        return "created";
      } catch (error) {
        await connection.rollback().catch(() => {});
        if (reserved && !committed) {
          // A lost COMMIT acknowledgement is reconciled by the durable customer ID when the DB is reachable.
          let found = false;
          try {
            const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM customers WHERE id=?",[value.id]);
            found = rows.length > 0;
          } catch { /* fail closed, retry only after explicit duplicate check */ }
          if (found) return "created";
          const index = store.customers.findIndex(c => c.id === value.id);
          if (index >= 0) store.customers.splice(index,1);
        }
        throw error;
      } finally {
        if (locked) {
          try { await connection.execute("SELECT RELEASE_LOCK(?)",[lockName]); }
          catch { connection.destroy(); }
        }
        connection.release();
      }
    });
  }
  private async transaction<T>(op: (connection: PoolConnection) => Promise<T>) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const value = await op(connection);
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally { connection.release(); }
  }
  async issue(ownerId: string, teamId: string, authVersion: number, label: string) {
    const token = newIntakeToken();
    const now = Date.now();
    const record: IntakeTokenRecord = { id: randomUUID(), label, ownerId, teamId, authVersion, createdAt: now,
      expiresAt: now + INTAKE_TOKEN_TTL_MS, revokedAt: null, lastUsedAt: null };
    await this.transaction(async connection => {
      await connection.execute("INSERT INTO external_customer_intake_tokens (id,digest,label,owner_id,team_id,auth_version,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?,?,?,?)",
        [record.id,intakeTokenDigest(token),label,ownerId,teamId,authVersion,now,record.expiresAt]);
      await connection.execute("INSERT INTO external_customer_intake_audit (id,token_id,actor_id,team_id,action,outcome,created_at_ms,finished_at_ms) VALUES (?,?,?,?,?,?,?,?)",
        [randomUUID(),record.id,ownerId,teamId,"issue","ok",now,now]);
    });
    return { token, record };
  }
  async lookup(token: string) {
    const digest = intakeTokenDigest(token);
    if (!digest) return null;
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT ${tokenFields} FROM external_customer_intake_tokens WHERE digest=?`, [digest]);
    return rows.length ? fromRow(rows[0]) : null;
  }
  async list(teamId: string, ownerId?: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT ${tokenFields} FROM external_customer_intake_tokens WHERE team_id=?${ownerId === undefined ? "" : " AND owner_id=?"} ORDER BY created_at_ms DESC LIMIT 200`, ownerId === undefined ? [teamId] : [teamId, ownerId]);
    return rows.map(fromRow);
  }
  async revoke(id: string, teamId: string, actorId: string, teamAdmin: boolean) {
    const now = Date.now();
    return this.transaction(async connection => {
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE external_customer_intake_tokens SET revoked_at_ms=? WHERE id=? AND team_id=? AND revoked_at_ms IS NULL" + (teamAdmin ? "" : " AND owner_id=?"),
        teamAdmin ? [now,id,teamId] : [now,id,teamId,actorId]);
      if (!result.affectedRows) return false;
      await connection.execute("INSERT INTO external_customer_intake_audit (id,token_id,actor_id,team_id,action,outcome,created_at_ms,finished_at_ms) VALUES (?,?,?,?,?,?,?,?)",
        [randomUUID(),id,actorId,teamId,"revoke","ok",now,now]);
      return true;
    });
  }
  async beginUse(record: IntakeTokenRecord, action: "check" | "create") {
    const id = randomUUID(), now = Date.now();
    return this.transaction(async connection => {
      const [result] = await connection.execute<ResultSetHeader>("UPDATE external_customer_intake_tokens SET last_used_at_ms=? WHERE id=? AND revoked_at_ms IS NULL AND expires_at_ms>?", [now,record.id,now]);
      if (!result.affectedRows) return null;
      await connection.execute("INSERT INTO external_customer_intake_audit (id,token_id,actor_id,team_id,action,outcome,created_at_ms) VALUES (?,?,?,?,?,?,?)", [id,record.id,record.ownerId,record.teamId,action,"started",now]);
      return id;
    });
  }
  async finishUse(id: string, outcome: "clear" | "duplicate" | "created" | "failed") {
    await this.pool.execute("UPDATE external_customer_intake_audit SET outcome=?, finished_at_ms=? WHERE id=? AND outcome='started'", [outcome,Date.now(),id]);
  }
}
let repository: MysqlExternalIntakeRepository | undefined;
export function setExternalIntakeRepository(pool: Pool | null, enqueue?: Serialized) { repository = pool && enqueue ? new MysqlExternalIntakeRepository(pool,enqueue) : undefined; }
export function getExternalIntakeRepository() { return repository; }
