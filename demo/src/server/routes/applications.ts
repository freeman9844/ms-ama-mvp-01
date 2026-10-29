import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { ServerOptions } from "../app.js";
import { context, requireRole } from "../auth.js";
import { DomainError } from "../errors.js";
import { idempotent } from "../transactions.js";
import { collectionQueries } from "../../agents/consent.js";
import { enqueue } from "../../workflow/queue.js";

export const applicationInputSchema = z.object({
  companyName: z.string().min(1).max(100),
  requestedAmountKrw: z.number().int().positive().safe(),
  consentIds: z.array(z.string()).length(3),
});
export const submittedSchema = z.object({ applicationId: z.string(), jobId: z.string() });
export const applicationRowSchema = z.object({
  id: z.string(),
  business_id: z.string(),
  status: z.string(),
  payload: z.string(),
  dataset_id: z.string().nullable(),
  dataset_version: z.number(),
  assessment_id: z.string().nullable(),
  assessment_version: z.number(),
  created_at: z.string(),
});
export function applicationRoutes(app: Express, options: ServerOptions) {
  app.post("/api/applications/:id/corrections", (req, res) => {
    const actor = context(req).actor;
    requireRole(actor, ["BORROWER"]);
    const body = z
      .object({
        fixtureId: z.literal("synthetic-confirmation"),
        consentIds: z.array(z.string()).length(3).optional(),
      })
      .parse(req.body);
    const raw = options.db
      .prepare("SELECT * FROM applications WHERE id=?")
      .get(z.string().parse(req.params.id));
    if (!raw) throw new DomainError("NOT_FOUND", 404);
    const row = applicationRowSchema.parse(raw);
    if (row.business_id !== actor.businessId) throw new DomainError("FORBIDDEN", 403);
    const result = idempotent(
      options.db,
      actor.id,
      req.path,
      req.get("idempotency-key"),
      body,
      z.object({ jobId: z.string() }),
      () => {
        if (row.status !== "NEEDS_INFORMATION")
          throw new DomainError("CORRECTION_NOT_REQUESTED", 409);
        const input = applicationInputSchema.parse(JSON.parse(row.payload));
        input.consentIds = body.consentIds ?? input.consentIds;
        collectionQueries(
          options.db,
          input.consentIds,
          row.business_id,
          "ASSESSMENT",
          options.clock.now(),
        );
        options.db
          .prepare("UPDATE applications SET payload=? WHERE id=?")
          .run(JSON.stringify(input), row.id);
        options.db
          .prepare(
            "UPDATE jobs SET status='CANCELLED' WHERE application_id=? AND status IN ('QUEUED','RUNNING')",
          )
          .run(row.id);
        options.db.prepare("UPDATE applications SET status='COLLECTING' WHERE id=?").run(row.id);
        const setting = options.db.prepare("SELECT value FROM settings WHERE key='model_id'").get();
        const modelId = setting ? z.object({ value: z.string() }).parse(setting).value : "";
        return {
          jobId: enqueue(options.db, {
            kind: "ASSEMBLE",
            applicationId: row.id,
            businessId: row.business_id,
            consentIds: input.consentIds,
            modelId,
            referenceId: null,
          }),
        };
      },
    );
    res.status(202).json(result);
  });
  app.post("/api/applications", (req, res) => {
    const actor = context(req).actor;
    requireRole(actor, ["BORROWER"]);
    const body = applicationInputSchema.parse(req.body);
    const result = idempotent(
      options.db,
      actor.id,
      req.path,
      req.get("idempotency-key"),
      body,
      submittedSchema,
      () => {
        collectionQueries(
          options.db,
          body.consentIds,
          actor.businessId!,
          "ASSESSMENT",
          options.clock.now(),
        );
        const applicationId = randomUUID();
        options.db
          .prepare(
            "INSERT INTO applications (id,business_id,status,payload,created_at) VALUES (?,?,'SUBMITTED',?,?)",
          )
          .run(
            applicationId,
            actor.businessId,
            JSON.stringify(body),
            options.clock.now().toISOString(),
          );
        const setting = options.db.prepare("SELECT value FROM settings WHERE key='model_id'").get();
        const modelId = setting ? z.object({ value: z.string() }).parse(setting).value : "";
        const jobId = enqueue(options.db, {
          kind: "ASSEMBLE",
          applicationId,
          businessId: actor.businessId!,
          consentIds: body.consentIds,
          modelId,
          referenceId: null,
        });
        return { applicationId, jobId };
      },
    );
    res.status(202).json(result);
  });
  app.get("/api/applications", (req, res) => {
    const actor = context(req).actor;
    const rows =
      actor.role === "BORROWER"
        ? options.db.prepare("SELECT * FROM applications WHERE business_id=?").all(actor.businessId)
        : options.db.prepare("SELECT * FROM applications").all();
    res.json(
      rows.map((raw) => {
        const row = applicationRowSchema.parse(raw);
        return {
          id: row.id,
          status: row.status,
          createdAt: row.created_at,
          evidenceDeleted: row.dataset_version > 0 && row.dataset_id === null,
          ...applicationInputSchema.parse(JSON.parse(row.payload)),
        };
      }),
    );
  });
  app.get("/api/applications/:id", (req, res) => {
    const raw = options.db
      .prepare("SELECT * FROM applications WHERE id=?")
      .get(z.string().parse(req.params.id));
    if (!raw) throw new DomainError("NOT_FOUND", 404);
    const row = applicationRowSchema.parse(raw);
    const actor = context(req).actor;
    if (actor.role === "BORROWER" && actor.businessId !== row.business_id)
      throw new DomainError("FORBIDDEN", 403);
    res.json({
      id: row.id,
      status: row.status,
      datasetVersion: row.dataset_version,
      assessmentVersion: row.assessment_version,
      evidenceDeleted: row.dataset_version > 0 && row.dataset_id === null,
      ...applicationInputSchema.parse(JSON.parse(row.payload)),
    });
  });
}
