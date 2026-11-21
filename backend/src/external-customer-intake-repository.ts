import type { Pool, RowDataPacket, ResultSetHeader, PoolConnection } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { intakeTokenDigest, newIntakeToken, INTAKE_TOKEN_TTL_MS, type IntakeGrant } from "./external-customer-intake-policy.js";

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
  constructor(private readonly pool: Pool) {}
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
export function setExternalIntakeRepository(pool: Pool) { repository = new MysqlExternalIntakeRepository(pool); }
export function getExternalIntakeRepository() { return repository; }
