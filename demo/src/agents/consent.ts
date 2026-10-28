import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  consentQuerySchema,
  purposeSchema,
  sourceSchema,
  timestampSchema,
  type Actor,
  type ConsentProof,
  type ConsentQuery,
} from "../domain/contracts.js";
import type { Clock } from "../domain/clock.js";
import { requireRole } from "../server/auth.js";
import { DomainError } from "../server/errors.js";
import { transaction } from "../server/transactions.js";
import { enqueue } from "../workflow/queue.js";

export const consentInputSchema = z
  .object({
    purpose: purposeSchema,
    source: sourceSchema,
    resourceIds: z.array(z.string()).min(1),
    from: timestampSchema,
    to: timestampSchema,
    validUntil: timestampSchema,
    accepted: z.literal(true),
  })
  .refine((x) => Date.parse(x.from) < Date.parse(x.to), "Invalid consent interval");
const consentRowSchema = z.object({
  id: z.string(),
  business_id: z.string(),
  payload: z.string(),
  status: z.string(),
  version: z.number().int(),
});

export function grantConsent(
  db: DatabaseSync,
  clock: Clock,
  actor: Actor,
  input: unknown,
): ConsentProof {
  requireRole(actor, ["BORROWER"]);
  const data = consentInputSchema.parse(input);
  if (
    !actor.businessId ||
    data.resourceIds.some((id) => id !== `${data.source.toLowerCase()}-${actor.businessId}`)
  ) {
    throw new DomainError("RESOURCE_NOT_OWNED", 403);
  }
  const days = data.purpose === "ASSESSMENT" ? 30 : 60;
  if (
    Date.parse(data.validUntil) <= clock.now().getTime() ||
    Date.parse(data.validUntil) > clock.now().getTime() + days * 86_400_000
  ) {
    throw new DomainError("INVALID_CONSENT_EXPIRY", 400);
  }
  const id = randomUUID();
  db.prepare("INSERT INTO consents (id, business_id, payload) VALUES (?, ?, ?)").run(
    id,
    actor.businessId,
    JSON.stringify(data),
  );
  return { id, version: 1, validUntil: data.validUntil };
}

export function authorize(db: DatabaseSync, input: ConsentQuery, now: Date): ConsentProof {
  const query = consentQuerySchema.parse(input);
  const raw = db.prepare("SELECT * FROM consents WHERE id = ?").get(query.consentId);
  if (!raw) throw new DomainError("CONSENT_INACTIVE", 403);
  const row = consentRowSchema.parse(raw);
  const consent = consentInputSchema.parse(JSON.parse(row.payload));
  if (row.status !== "ACTIVE" || now.getTime() >= Date.parse(consent.validUntil)) {
    throw new DomainError("CONSENT_INACTIVE", 403);
  }
  if (
    row.business_id !== query.businessId ||
    consent.source !== query.source ||
    consent.purpose !== query.purpose ||
    query.resourceIds.some((id) => !consent.resourceIds.includes(id)) ||
    Date.parse(query.from) < Date.parse(consent.from) ||
    Date.parse(query.to) > Date.parse(consent.to)
  ) {
    throw new DomainError("CONSENT_SCOPE", 403);
  }
  return { id: row.id, version: row.version, validUntil: consent.validUntil };
}

export function listConsents(db: DatabaseSync, actor: Actor) {
  const rows =
    actor.role === "BORROWER"
      ? db.prepare("SELECT * FROM consents WHERE business_id = ?").all(actor.businessId)
      : db.prepare("SELECT * FROM consents").all();
  return rows.map((raw) => {
    const row = consentRowSchema.parse(raw);
    return {
      id: row.id,
      businessId: row.business_id,
      status: row.status,
      version: row.version,
      ...consentInputSchema.parse(JSON.parse(row.payload)),
    };
  });
}

function blockConsent(db: DatabaseSync, id: string, status: "REVOKED" | "EXPIRED") {
  return transaction(db, () => {
    const row = consentRowSchema.parse(db.prepare("SELECT * FROM consents WHERE id=?").get(id));
    const existing = db.prepare("SELECT job_id FROM deletion_requests WHERE consent_id=?").get(id);
    if (existing) return z.object({ job_id: z.string() }).parse(existing).job_id;
    db.prepare("UPDATE consents SET status=?,version=version+1 WHERE id=?").run(status, id);
    db.prepare(
      "UPDATE datasets SET validation_status='INVALIDATED' WHERE id IN (SELECT dataset_id FROM dataset_consents WHERE consent_id=?)",
    ).run(id);
    db.prepare(
      "UPDATE jobs SET status='BLOCKED_BY_CONSENT',error_code='CONSENT_INACTIVE' WHERE kind<>'DELETE' AND status IN ('QUEUED','RUNNING') AND EXISTS(SELECT 1 FROM json_each(jobs.consent_ids) WHERE value=?)",
    ).run(id);
    const jobId = enqueue(db, {
      kind: "DELETE",
      applicationId: null,
      businessId: row.business_id,
      consentIds: [id],
      modelId: "",
      referenceId: id,
    });
    db.prepare("INSERT INTO deletion_requests VALUES (?,?,'PENDING',NULL)").run(id, jobId);
    return jobId;
  });
}

export function revokeConsent(db: DatabaseSync, clock: Clock, actor: Actor, consentId: string) {
  requireRole(actor, ["BORROWER"]);
  const raw = db.prepare("SELECT * FROM consents WHERE id=?").get(consentId);
  if (!raw) throw new DomainError("NOT_FOUND", 404);
  const row = consentRowSchema.parse(raw);
  if (row.business_id !== actor.businessId) throw new DomainError("FORBIDDEN", 403);
  const deletionJobId = blockConsent(db, consentId, "REVOKED");
  db.prepare("INSERT OR IGNORE INTO audit_events VALUES (?,?,?,'CONSENT_BLOCKED',?,NULL)").run(
    `revoke-${consentId}`,
    clock.now().toISOString(),
    actor.id,
    consentId,
  );
  return { access: "BLOCKED" as const, deletionJobId };
}

export function expireConsents(db: DatabaseSync, clock: Clock): number {
  const expired = db
    .prepare("SELECT id,payload FROM consents WHERE status='ACTIVE'")
    .all()
    .map((raw) => z.object({ id: z.string(), payload: z.string() }).parse(raw))
    .filter(
      (row) =>
        Date.parse(consentInputSchema.parse(JSON.parse(row.payload)).validUntil) <=
        clock.now().getTime(),
    );
  for (const row of expired) blockConsent(db, row.id, "EXPIRED");
  return expired.length;
}

export function startConsentSweeper(db: DatabaseSync, clock: Clock) {
  expireConsents(db, clock);
  const timer = setInterval(() => expireConsents(db, clock), 1_000);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
