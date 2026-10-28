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
