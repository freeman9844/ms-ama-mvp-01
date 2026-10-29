import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ServerOptions } from "../app.js";
import { context, requireRole } from "../auth.js";
import { DomainError } from "../errors.js";
import { idempotent } from "../transactions.js";
import { submitSupport } from "../../agents/collections.js";
import { businessDate } from "../../domain/clock.js";
import { timestampSchema } from "../../domain/contracts.js";

export function supportRoutes(app: Express, options: ServerOptions) {
  const { db, clock } = options;
  app.post("/api/support-requests", (req, res) => {
    const actor = context(req).actor;
    requireRole(actor, ["BORROWER"]);
    const body = z
      .object({
        applicationId: z.string(),
        text: z.string().trim().min(1).max(500),
        kind: z.enum([
          "GENERAL_INQUIRY",
          "PAYMENT_DIFFICULTY",
          "DISPUTE_OR_CORRECTION",
          "COMPLAINT",
        ]),
      })
      .parse(req.body);
    if (
      !db
        .prepare("SELECT 1 FROM applications WHERE id=? AND business_id=?")
        .get(body.applicationId, actor.businessId)
    )
      throw new DomainError("APPLICATION_NOT_FOUND", 404);
    const result = idempotent(
      db,
      actor.id,
      req.path,
      req.get("idempotency-key"),
      body,
      z.object({ id: z.string(), jobId: z.string() }),
      () => submitSupport(db, { ...body, businessId: actor.businessId! }),
    );
    res.status(202).json(result);
  });
  app.post("/api/support-requests/:id/review", (req, res) => {
    const actor = context(req).actor;
    requireRole(actor, ["OFFICER"]);
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("COMPLETE") }),
        z.object({
          action: z.literal("CHANGE_DUE_DATE"),
          scheduleId: z.string(),
          scheduleVersion: z.number().int().positive(),
          dueAt: timestampSchema,
        }),
      ])
      .parse(req.body);
    const result = idempotent(
      db,
      actor.id,
      req.path,
      req.get("idempotency-key"),
      body,
      z.object({ reviewId: z.string() }),
      () => {
        if (db.prepare("SELECT 1 FROM demo_events WHERE state='PENDING'").get())
          throw new DomainError("EVENT_IN_PROGRESS", 409);
        const raw = db
          .prepare("SELECT * FROM support_requests WHERE id=?")
          .get(z.string().parse(req.params.id));
        if (!raw) throw new DomainError("NOT_FOUND", 404);
        const request = z
          .object({ id: z.string(), application_id: z.string(), status: z.string() })
          .parse(raw);
        if (!["AWAITING_REVIEW", "AWAITING_HUMAN"].includes(request.status))
          throw new DomainError("SUPPORT_NOT_REVIEWABLE", 409);
        if (body.action === "CHANGE_DUE_DATE") {
          const rawSchedule = db
            .prepare(
              "SELECT s.* FROM repayment_schedules s JOIN loans l ON l.id=s.loan_id WHERE s.id=? AND l.application_id=? AND l.status='ACTIVE'",
            )
            .get(body.scheduleId, request.application_id);
          if (!rawSchedule) throw new DomainError("SCHEDULE_NOT_FOUND", 404);
          const schedule = z
            .object({ version: z.number(), due_at: z.string(), status: z.string() })
            .parse(rawSchedule);
          const due = Date.parse(body.dueAt);
          if (
            schedule.version !== body.scheduleVersion ||
            schedule.status === "PAID" ||
            due <= Date.parse(schedule.due_at) ||
            due > Date.parse(schedule.due_at) + 30 * 86_400_000 ||
            businessDate(new Date(due)) < businessDate(clock.now())
          )
            throw new DomainError("INVALID_SCHEDULE_CHANGE", 409);
          db.prepare(
            "UPDATE repayment_schedules SET due_at=?,version=version+1,status='SCHEDULED' WHERE id=?",
          ).run(body.dueAt, body.scheduleId);
        }
        const reviewId = randomUUID();
        db.prepare("INSERT INTO support_reviews VALUES (?,?,?,?,?)").run(
          reviewId,
          request.id,
          actor.id,
          JSON.stringify(body),
          clock.now().toISOString(),
        );
        db.prepare("UPDATE support_requests SET status='REVIEWED' WHERE id=?").run(request.id);
        db.prepare(
          "UPDATE jobs SET status='CANCELLED' WHERE kind='SUPPORT' AND reference_id=? AND status IN ('QUEUED','RUNNING')",
        ).run(request.id);
        return { reviewId };
      },
    );
    res.json(result);
  });
}
