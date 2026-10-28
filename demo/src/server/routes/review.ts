import type { Express } from "express";
import { z } from "zod";
import { review, reviewInputSchema } from "../../agents/underwriting.js";
import { readDataset } from "../../agents/assembly.js";
import { assessmentSchema } from "../../copilot/schemas.js";
import type { ServerOptions } from "../app.js";
import { context, requireRole } from "../auth.js";
import { DomainError } from "../errors.js";
import { idempotent } from "../transactions.js";

export function reviewRoutes(app: Express, options: ServerOptions) {
  app.post("/api/applications/:id/review", (req, res) => {
    const actor = context(req).actor;
    requireRole(actor, ["OFFICER"]);
    const input = reviewInputSchema.parse({
      ...z.record(z.string(), z.unknown()).parse(req.body),
      applicationId: req.params.id,
    });
    const result = idempotent(
      options.db,
      actor.id,
      req.path,
      req.get("idempotency-key"),
      input,
      z.object({ decisionId: z.string(), applicationStatus: z.string() }),
      () => review(options.db, options.clock, actor, input),
    );
    res.json(result);
  });
  app.get("/api/applications/:id/assessment", (req, res) => {
    requireRole(context(req).actor, ["OFFICER"]);
    const raw = options.db
      .prepare("SELECT dataset_id,assessment_id FROM applications WHERE id=?")
      .get(z.string().parse(req.params.id));
    if (!raw) throw new DomainError("NOT_FOUND", 404);
    const app = z
      .object({ dataset_id: z.string().nullable(), assessment_id: z.string().nullable() })
      .parse(raw);
    if (!app.dataset_id || !app.assessment_id) throw new DomainError("ASSESSMENT_NOT_READY", 409);
    const data = readDataset(options.db, app.dataset_id);
    const saved = options.db
      .prepare("SELECT payload,version FROM assessments WHERE id=? AND status='VALID'")
      .get(app.assessment_id);
    if (!saved) throw new DomainError("ASSESSMENT_NOT_READY", 409);
    const row = z.object({ payload: z.string(), version: z.number() }).parse(saved);
    res.json({
      dataset: data,
      assessment: assessmentSchema.parse(JSON.parse(row.payload)),
      assessmentVersion: row.version,
    });
  });
}
