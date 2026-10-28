import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "../server/transactions.js";
import { DomainError } from "../server/errors.js";
import { consentInputSchema } from "../agents/consent.js";
export type JobKind = "ASSEMBLE" | "UNDERWRITE" | "MONITOR" | "SUPPORT" | "DELETE";
export type Job = {
  id: string;
  kind: JobKind;
  applicationId: string | null;
  businessId: string;
  consentIds: string[];
  generation: number;
  attempt: number;
  claimToken: string;
  modelId: string;
  referenceId: string | null;
};
const rowSchema = z.object({
  id: z.string(),
  kind: z.enum(["ASSEMBLE", "UNDERWRITE", "MONITOR", "SUPPORT", "DELETE"]),
  application_id: z.string().nullable(),
  business_id: z.string(),
  consent_ids: z.string(),
  generation: z.number(),
  attempt: z.number(),
  claim_token: z.string(),
  model_id: z.string(),
  status: z.string(),
  lease_until_ms: z.number(),
  reference_id: z.string().nullable(),
});
export function generation(db: DatabaseSync): number {
  return Number(
    z
      .object({ value: z.string() })
      .parse(db.prepare("SELECT value FROM settings WHERE key='generation'").get()).value,
  );
}

export function getJob(
  db: DatabaseSync,
  id: string,
): Job & { status: string; errorCode: string | null } {
  const raw = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  if (!raw) throw new DomainError("NOT_FOUND", 404);
  const row = rowSchema.extend({ error_code: z.string().nullable() }).parse(raw);
  return {
    id: row.id,
    kind: row.kind,
    applicationId: row.application_id,
    businessId: row.business_id,
    consentIds: z.array(z.string()).parse(JSON.parse(row.consent_ids)),
    generation: row.generation,
    attempt: row.attempt,
    claimToken: row.claim_token,
    modelId: row.model_id,
    referenceId: row.reference_id,
    status: row.status,
    errorCode: row.error_code,
  };
}

export function requireActiveConsents(
  db: DatabaseSync,
  ids: string[],
  businessId: string,
  now: Date,
) {
  for (const id of ids) {
    const raw = db.prepare("SELECT status,payload,business_id FROM consents WHERE id=?").get(id);
    if (!raw) throw new DomainError("CONSENT_INACTIVE", 403);
    const row = z
      .object({ status: z.string(), payload: z.string(), business_id: z.string() })
      .parse(raw);
    const consent = consentInputSchema.parse(JSON.parse(row.payload));
    if (
      row.status !== "ACTIVE" ||
      row.business_id !== businessId ||
      now.getTime() >= Date.parse(consent.validUntil)
    )
      throw new DomainError("CONSENT_INACTIVE", 403);
  }
}
export function enqueue(
  db: DatabaseSync,
  input: Omit<Job, "id" | "generation" | "attempt" | "claimToken">,
): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO jobs (id,kind,application_id,business_id,consent_ids,generation,model_id,reference_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    id,
    input.kind,
    input.applicationId,
    input.businessId,
    JSON.stringify(input.consentIds),
    generation(db),
    input.modelId,
    input.referenceId,
  );
  return id;
}
export function claim(
  db: DatabaseSync,
  realNowMs: number,
  kinds: readonly JobKind[] = ["ASSEMBLE", "UNDERWRITE", "MONITOR", "SUPPORT", "DELETE"],
): Job | null {
  if (!kinds.length) return null;
  return transaction(db, () => {
    db.prepare(
      "UPDATE jobs SET status='FAILED',error_code='ATTEMPT_LIMIT' WHERE attempt >= CASE WHEN kind IN ('UNDERWRITE','MONITOR','SUPPORT') THEN 2 ELSE 3 END AND (status='QUEUED' OR (status='RUNNING' AND lease_until_ms<=?))",
    ).run(realNowMs);
    const raw = db
      .prepare(
        `SELECT * FROM jobs WHERE generation=? AND kind IN (${kinds.map(() => "?").join(",")})
      AND ((status='QUEUED' AND retry_at_ms<=?) OR (status='RUNNING' AND lease_until_ms<=?))
      ORDER BY rowid LIMIT 1`,
      )
      .get(generation(db), ...kinds, realNowMs, realNowMs);
    if (!raw) return null;
    const row = rowSchema.parse(raw);
    const token = randomUUID();
    db.prepare(
      "UPDATE jobs SET status='RUNNING', claim_token=?, lease_until_ms=?, attempt=attempt+1 WHERE id=?",
    ).run(token, realNowMs + 60_000, row.id);
    return {
      id: row.id,
      kind: row.kind,
      applicationId: row.application_id,
      businessId: row.business_id,
      consentIds: z.array(z.string()).parse(JSON.parse(row.consent_ids)),
      generation: row.generation,
      attempt: row.attempt + 1,
      claimToken: token,
      modelId: row.model_id,
      referenceId: row.reference_id,
    };
  });
}
export function assertJob(db: DatabaseSync, job: Job, now: Date): void {
  const raw = db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
  if (!raw) throw new DomainError("JOB_INVALIDATED", 409);
  const row = rowSchema.parse(raw);
  if (
    row.status !== "RUNNING" ||
    row.claim_token !== job.claimToken ||
    row.generation !== generation(db) ||
    row.lease_until_ms <= Date.now()
  ) {
    throw new DomainError("JOB_INVALIDATED", 409);
  }
  if (job.kind === "DELETE") return;
  for (const id of job.consentIds) {
    const consent = z
      .object({ status: z.string(), payload: z.string(), business_id: z.string() })
      .parse(db.prepare("SELECT status,payload,business_id FROM consents WHERE id=?").get(id));
    const data = consentInputSchema.parse(JSON.parse(consent.payload));
    if (
      consent.status !== "ACTIVE" ||
      consent.business_id !== job.businessId ||
      now.getTime() >= Date.parse(data.validUntil)
    )
      throw new DomainError("CONSENT_INACTIVE", 403);
  }
}
export function complete(db: DatabaseSync, job: Job, resultId: string, businessNow: Date): boolean {
  return transaction(db, () => {
    try {
      assertJob(db, job, businessNow);
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
    if (job.kind === "ASSEMBLE") {
      const result = db
        .prepare(
          "UPDATE datasets SET validation_status='VALID' WHERE id=? AND application_id=? AND validation_status='STAGED'",
        )
        .run(resultId, job.applicationId);
      if (result.changes !== 1) throw new DomainError("RESULT_NOT_STAGED", 409);
      db.prepare(
        "UPDATE applications SET status='ANALYZING',dataset_id=?,dataset_version=(SELECT version FROM datasets WHERE id=?) WHERE id=?",
      ).run(resultId, resultId, job.applicationId);
      enqueue(db, { ...job, kind: "UNDERWRITE" });
    }
    if (job.kind === "UNDERWRITE") {
      const app = z
        .object({ dataset_id: z.string() })
        .parse(db.prepare("SELECT dataset_id FROM applications WHERE id=?").get(job.applicationId));
      const result = db
        .prepare(
          "UPDATE assessments SET status='VALID' WHERE id=? AND application_id=? AND dataset_id=? AND status='STAGED'",
        )
        .run(resultId, job.applicationId, app.dataset_id);
      if (result.changes !== 1) throw new DomainError("RESULT_NOT_STAGED", 409);
      db.prepare(
        "UPDATE applications SET status='AWAITING_REVIEW',assessment_id=?,assessment_version=(SELECT version FROM assessments WHERE id=?) WHERE id=?",
      ).run(resultId, resultId, job.applicationId);
    }
    db.prepare("UPDATE jobs SET status='COMPLETED',result_id=? WHERE id=? AND claim_token=?").run(
      resultId,
      job.id,
      job.claimToken,
    );
    return true;
  });
}
export function fail(db: DatabaseSync, job: Job, error: unknown) {
  const code = error instanceof DomainError ? error.code : "JOB_EXECUTION_FAILED";
  const blocked = code.includes("CONSENT");
  const retry =
    ["SOURCE_UNAVAILABLE", "SOURCE_SNAPSHOT_CHANGED", "AI_TRANSIENT"].includes(code) &&
    job.attempt < (["UNDERWRITE", "MONITOR", "SUPPORT"].includes(job.kind) ? 2 : 3);
  db.prepare(
    "UPDATE jobs SET status=?,error_code=?,retry_at_ms=? WHERE id=? AND status='RUNNING' AND claim_token=?",
  ).run(
    blocked ? "BLOCKED_BY_CONSENT" : retry ? "QUEUED" : "FAILED",
    code,
    Date.now() + 1_000,
    job.id,
    job.claimToken,
  );
  if (job.applicationId && ["BALANCE_MISMATCH", "CONFLICTING_RECORD"].includes(code)) {
    db.prepare("UPDATE applications SET status='NEEDS_INFORMATION' WHERE id=?").run(
      job.applicationId,
    );
  }
  if (code === "JOB_EXECUTION_FAILED")
    console.error(
      JSON.stringify({
        jobId: job.id,
        code,
        type: error instanceof Error ? error.name : "UnknownError",
      }),
    );
}
