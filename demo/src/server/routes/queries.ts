import type { Express } from "express";
import { z } from "zod";
import type { ServerOptions } from "../app.js";
import { context, requireRole } from "../auth.js";
import { readAuthorizedDataset } from "../../agents/assembly.js";
import { DomainError } from "../errors.js";
import { warningSchema } from "../../copilot/schemas.js";
import { loanView, supportView, timelineView, alertView } from "../../domain/views.js";

export function queryRoutes(app: Express, options: ServerOptions) {
  const { db, clock } = options;
  app.get("/api/demo/state", (_req, res) => {
    const model = db.prepare("SELECT value FROM settings WHERE key='model_id'").get();
    res.json({
      now: clock.now().toISOString(),
      modelId: model ? z.object({ value: z.string() }).parse(model).value : null,
    });
  });
  app.get("/api/loans", (req, res) => {
    const actor = context(req).actor;
    const rows =
      actor.role === "BORROWER"
        ? db.prepare("SELECT * FROM loans WHERE business_id=?").all(actor.businessId)
        : db.prepare("SELECT * FROM loans").all();
    res.json(
      rows.map((raw) => {
        const row = z
          .object({
            id: z.string(),
            application_id: z.string(),
            business_id: z.string(),
            status: z.string(),
          })
          .parse(raw);
        const schedules = db
          .prepare("SELECT * FROM repayment_schedules WHERE loan_id=?")
          .all(row.id)
          .map((raw) => {
            const s = z
              .object({
                id: z.string(),
                due_at: z.string(),
                amount_krw: z.number(),
                status: z.string(),
                version: z.number(),
              })
              .parse(raw);
            return {
              id: s.id,
              dueAt: s.due_at,
              amountKrw: s.amount_krw,
              status: s.status,
              version: s.version,
            };
          });
        return loanView.parse({
          id: row.id,
          applicationId: row.application_id,
          businessId: row.business_id,
          status: row.status,
          schedules,
        });
      }),
    );
  });
  app.get("/api/support-requests", (req, res) => {
    const actor = context(req).actor;
    requireRole(actor, ["BORROWER", "OFFICER"]);
    const rows =
      actor.role === "BORROWER"
        ? db.prepare("SELECT * FROM support_requests WHERE business_id=?").all(actor.businessId)
        : db.prepare("SELECT * FROM support_requests").all();
    res.json(
      rows.map((raw) => {
        const row = z
          .object({
            id: z.string(),
            application_id: z.string(),
            kind: z.string(),
            text: z.string(),
            route: z.string().nullable(),
            status: z.string(),
            error_code: z.string().nullable(),
          })
          .parse(raw);
        return supportView.parse({
          id: row.id,
          applicationId: row.application_id,
          kind: row.kind,
          text: row.text,
          route: row.route,
          status: row.status,
          errorCode: row.error_code,
          messages: db
            .prepare("SELECT text,state,reason FROM mock_messages WHERE request_id=?")
            .all(row.id),
        });
      }),
    );
  });
  app.get("/api/alerts", (req, res) => {
    requireRole(context(req).actor, ["OFFICER"]);
    const rows = db.prepare("SELECT * FROM alerts").all();
    const visible = [];
    for (const raw of rows) {
      const row = z
        .object({
          id: z.string(),
          application_id: z.string(),
          dataset_id: z.string(),
          code: z.string(),
          state: z.string(),
          minimum_krw: z.number(),
          explanation_status: z.string(),
          explanation: z.string().nullable(),
        })
        .parse(raw);
      try {
        readAuthorizedDataset(db, clock, row.dataset_id);
      } catch (error) {
        if (
          error instanceof DomainError &&
          ["CONSENT_INACTIVE", "DATASET_UNAVAILABLE"].includes(error.code)
        )
          continue;
        throw error;
      }
      visible.push(
        alertView.parse({
          id: row.id,
          applicationId: row.application_id,
          code: row.code,
          state: row.state,
          minimumKrw: row.minimum_krw,
          explanationStatus: row.explanation_status,
          explanation: row.explanation ? warningSchema.parse(JSON.parse(row.explanation)) : null,
        }),
      );
    }
    res.json(visible);
  });
  app.get("/api/timeline", (req, res) => {
    const actor = context(req).actor;
    const rows =
      actor.role === "BORROWER"
        ? db
            .prepare("SELECT * FROM jobs WHERE business_id=? ORDER BY rowid DESC")
            .all(actor.businessId)
        : db.prepare("SELECT * FROM jobs ORDER BY rowid DESC").all();
    res.json(
      rows.map((raw) => {
        const row = z
          .object({
            id: z.string(),
            application_id: z.string().nullable(),
            kind: z.string(),
            status: z.string(),
            error_code: z.string().nullable(),
            model_id: z.string(),
          })
          .parse(raw);
        const count = z
          .object({ n: z.number() })
          .parse(
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM tool_events t JOIN ai_sessions s ON t.session_id=s.id WHERE s.job_id=?",
              )
              .get(row.id),
          );
        return timelineView.parse({
          id: row.id,
          applicationId: row.application_id,
          kind: row.kind,
          status: row.status,
          errorCode: row.error_code,
          modelId: row.model_id,
          toolCount: count.n,
        });
      }),
    );
  });
}
