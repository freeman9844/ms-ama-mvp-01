import type { Express } from "express";
import { z } from "zod";
import type { ServerOptions } from "../app.js";
import { context } from "../auth.js";
import { DomainError } from "../errors.js";
import { idempotent } from "../transactions.js";
import { getJob, enqueue, requireActiveConsents, assertWorkState } from "../../workflow/queue.js";

export function jobRoutes(app: Express, options: ServerOptions) {
  app.post("/api/jobs/:id/retry", (req, res) => {
    const actor = context(req).actor;
    const job = getJob(options.db, z.string().parse(req.params.id));
    if (actor.role !== "OFFICER" && actor.businessId !== job.businessId) {
      throw new DomainError("FORBIDDEN", 403);
    }
    const result = idempotent(
      options.db,
      actor.id,
      req.path,
      req.get("idempotency-key"),
      {},
      z.object({ jobId: z.string() }),
      () => {
        const job = getJob(options.db, z.string().parse(req.params.id));
        if (job.status !== "FAILED") throw new DomainError("JOB_NOT_RETRYABLE", 409);
        assertWorkState(options.db, job);
        if (
          job.kind !== "MONITOR" &&
          options.db
            .prepare(
              "SELECT 1 FROM jobs WHERE kind=? AND application_id IS ? AND reference_id IS ? AND rowid>(SELECT rowid FROM jobs WHERE id=?)",
            )
            .get(job.kind, job.applicationId, job.referenceId, job.id)
        )
          throw new DomainError("JOB_OBSOLETE", 409);
        if (job.kind !== "DELETE")
          requireActiveConsents(options.db, job.consentIds, job.businessId, options.clock.now());
        const setting = options.db.prepare("SELECT value FROM settings WHERE key='model_id'").get();
        const modelId = setting
          ? z.object({ value: z.string() }).parse(setting).value
          : job.modelId;
        const jobId = enqueue(options.db, { ...job, modelId });
        options.db.prepare("UPDATE jobs SET status='CANCELLED' WHERE id=?").run(job.id);
        if (job.kind === "DELETE")
          options.db
            .prepare(
              "UPDATE deletion_requests SET state='PENDING',error_code=NULL,job_id=? WHERE consent_id=?",
            )
            .run(jobId, job.referenceId);
        return { jobId };
      },
    );
    res.status(202).json(result);
  });
  app.get("/api/jobs/:id", (req, res) => {
    const raw = options.db
      .prepare("SELECT id,business_id,kind,status,error_code,result_id FROM jobs WHERE id=?")
      .get(z.string().parse(req.params.id));
    if (!raw) throw new DomainError("NOT_FOUND", 404);
    const row = z
      .object({
        id: z.string(),
        business_id: z.string(),
        kind: z.string(),
        status: z.string(),
        error_code: z.string().nullable(),
        result_id: z.string().nullable(),
      })
      .parse(raw);
    const actor = context(req).actor;
    if (actor.role === "BORROWER" && actor.businessId !== row.business_id) {
      throw new DomainError("FORBIDDEN", 403);
    }
    res.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      errorCode: row.error_code,
      resultId: row.result_id,
    });
  });
}
