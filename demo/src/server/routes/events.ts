import type { Express } from "express";
import type { ServerOptions } from "../app.js";
import { z } from "zod";
import { eventSchema, sourceEventSchema } from "../../domain/events.js";
import { context, requireRole } from "../auth.js";
import { DomainError, handler } from "../errors.js";
import { transaction } from "../transactions.js";
import { enqueue, generation } from "../../workflow/queue.js";
import { consentInputSchema, expireConsents } from "../../agents/consent.js";
import { submitSupport } from "../../agents/collections.js";

export function enqueueMonitoring(options: ServerOptions) {
  const { db, clock } = options;
  for (const raw of db
    .prepare("SELECT application_id,business_id FROM loans WHERE status='ACTIVE'")
    .all()) {
    const loan = z.object({ application_id: z.string(), business_id: z.string() }).parse(raw);
    const grants = db
      .prepare(
        "SELECT id,payload FROM consents WHERE business_id=? AND status='ACTIVE' ORDER BY rowid DESC",
      )
      .all(loan.business_id)
      .map((raw) => {
        const row = z.object({ id: z.string(), payload: z.string() }).parse(raw);
        return { id: row.id, ...consentInputSchema.parse(JSON.parse(row.payload)) };
      })
      .filter(
        (c) => c.purpose === "MONITORING" && Date.parse(c.validUntil) > clock.now().getTime(),
      );
    const ids = ["BANK", "PG", "TAX"].map((source) => grants.find((c) => c.source === source)?.id);
    if (ids.some((id) => !id)) continue;
    const consentIds = z.array(z.string()).parse(ids);
    const setting = db.prepare("SELECT value FROM settings WHERE key='model_id'").get();
    enqueue(db, {
      kind: "MONITOR",
      applicationId: loan.application_id,
      businessId: loan.business_id,
      consentIds,
      modelId: setting ? z.object({ value: z.string() }).parse(setting).value : "",
      referenceId: null,
    });
  }
}

export function eventRoutes(app: Express, options: ServerOptions) {
  app.post(
    "/api/demo/events",
    handler(async (req, res) => {
      requireRole(context(req).actor, ["OPERATOR"]);
      const event = eventSchema.parse(req.body);
      const { db, clock } = options;
      if (!options.sourceUrl || !options.setTime) throw new DomainError("DEMO_NOT_CONFIGURED", 503);
      const command = transaction(db, () => {
        const previous = db.prepare("SELECT * FROM demo_events WHERE id=?").get(event.id);
        if (previous) {
          const row = z
            .object({ payload: z.string(), state: z.string(), error_code: z.string().nullable() })
            .parse(previous);
          const value = sourceEventSchema.parse(JSON.parse(row.payload));
          if (JSON.stringify(value.event) !== JSON.stringify(event))
            throw new DomainError("EVENT_CONFLICT", 409);
          if (row.state === "FAILED") throw new DomainError(row.error_code ?? "EVENT_FAILED", 409);
          return row.state === "APPLIED" ? null : value;
        }
        if (db.prepare("SELECT 1 FROM demo_events WHERE state='PENDING'").get())
          throw new DomainError("EVENT_IN_PROGRESS", 409);
        let paymentKrw: number | undefined;
        if (event.type === "MISSED_PAYMENT" || event.type === "PAYMENT_RECEIVED") {
          const raw = db
            .prepare(
              "SELECT s.* FROM repayment_schedules s JOIN loans l ON l.id=s.loan_id WHERE s.id=? AND l.business_id=? AND l.status='ACTIVE'",
            )
            .get(event.scheduleId, event.businessId);
          if (!raw) throw new DomainError("SCHEDULE_NOT_FOUND", 404);
          const schedule = z
            .object({ due_at: z.string(), amount_krw: z.number(), status: z.string() })
            .parse(raw);
          if (
            schedule.status === "PAID" ||
            (event.type === "MISSED_PAYMENT" &&
              (schedule.status !== "SCHEDULED" ||
                Date.parse(schedule.due_at) > clock.now().getTime()))
          )
            throw new DomainError("INVALID_PAYMENT_EVENT", 409);
          if (event.type === "PAYMENT_RECEIVED") paymentKrw = schedule.amount_krw;
        }
        const value = sourceEventSchema.parse({
          event,
          generation: generation(db),
          occurredAt: clock.now().toISOString(),
          nextTime: new Date(
            clock.now().getTime() + (event.type === "ADVANCE_TIME" ? event.days * 86_400_000 : 1),
          ).toISOString(),
          paymentKrw,
        });
        db.prepare("INSERT INTO demo_events VALUES (?,?,'PENDING',NULL)").run(
          event.id,
          JSON.stringify(value),
        );
        return value;
      });
      if (!command) {
        res.json({ eventId: event.id, state: "APPLIED" });
        return;
      }
      const response = await fetch(`${options.sourceUrl}/internal/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.serviceToken}`,
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const failure = z
          .object({ error: z.object({ code: z.string() }) })
          .safeParse(await response.json());
        const code = failure.success ? failure.data.error.code : "SOURCE_EVENT_FAILED";
        if (response.status < 500)
          db.prepare("UPDATE demo_events SET state='FAILED',error_code=? WHERE id=?").run(
            code,
            event.id,
          );
        throw new DomainError(code, response.status);
      }
      const result = z.object({ nextTime: z.string() }).parse(await response.json());
      transaction(db, () => {
        if (generation(db) !== command.generation) throw new DomainError("GENERATION_CHANGED", 409);
        const state = z
          .object({ state: z.string() })
          .parse(db.prepare("SELECT state FROM demo_events WHERE id=?").get(event.id));
        if (state.state === "APPLIED") return;
        db.prepare("INSERT OR REPLACE INTO settings VALUES ('demo_time',?)").run(result.nextTime);
        options.setTime!(new Date(result.nextTime));
        expireConsents(db, clock);
        if (event.type === "MISSED_PAYMENT" || event.type === "PAYMENT_RECEIVED") {
          db.prepare("UPDATE repayment_schedules SET status=?,version=version+1 WHERE id=?").run(
            event.type === "MISSED_PAYMENT" ? "MISSED" : "PAID",
            event.scheduleId,
          );
          if (event.type === "MISSED_PAYMENT") {
            const loan = z
              .object({ application_id: z.string() })
              .parse(
                db
                  .prepare(
                    "SELECT l.application_id FROM loans l JOIN repayment_schedules s ON s.loan_id=l.id WHERE s.id=?",
                  )
                  .get(event.scheduleId),
              );
            submitSupport(db, {
              applicationId: loan.application_id,
              businessId: event.businessId,
              kind: "MISSED_PAYMENT",
              text: "합성 미납 사건입니다. 고객 보호 정책에 따라 검토하세요.",
            });
          }
        }
        enqueueMonitoring(options);
        db.prepare("UPDATE demo_events SET state='APPLIED' WHERE id=?").run(event.id);
      });
      res.json({ eventId: event.id, state: "APPLIED" });
    }),
  );
}
