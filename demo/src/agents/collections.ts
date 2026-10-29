import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
import type { AiPort } from "../copilot/port.js";
import type { JobHandler } from "../workflow/runner.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertJob, enqueue } from "../workflow/queue.js";
import { transaction } from "../server/transactions.js";
import { DomainError } from "../server/errors.js";
import { supportSchema } from "../copilot/schemas.js";
import { templates } from "../domain/support-policy.js";
import { businessDate } from "../domain/clock.js";

export function submitSupport(
  db: DatabaseSync,
  input: {
    applicationId: string;
    businessId: string;
    kind: string;
    text: string;
  },
) {
  const id = randomUUID();
  db.prepare("INSERT INTO support_requests VALUES (?,?,?,?,?,NULL,'QUEUED',NULL,NULL)").run(
    id,
    input.applicationId,
    input.businessId,
    input.kind,
    input.text,
  );
  const model = db.prepare("SELECT value FROM settings WHERE key='model_id'").get();
  const jobId = enqueue(db, {
    kind: "SUPPORT",
    applicationId: input.applicationId,
    businessId: input.businessId,
    consentIds: [],
    modelId: model ? z.object({ value: z.string() }).parse(model).value : "",
    referenceId: id,
  });
  return { id, jobId };
}

export function createSupportAgent(db: DatabaseSync, clock: Clock, ai: AiPort): JobHandler {
  return async (job, signal) => {
    assertJob(db, job, clock.now());
    const request = z
      .object({ id: z.string(), kind: z.string(), text: z.string(), business_id: z.string() })
      .parse(db.prepare("SELECT * FROM support_requests WHERE id=?").get(job.referenceId));
    if (request.business_id !== job.businessId) throw new DomainError("SUPPORT_SCOPE", 403);
    try {
      const response = await ai.run(
        {
          role: "COLLECTIONS",
          jobId: job.id,
          businessId: job.businessId,
          modelId: job.modelId,
          dataset: null,
          prompt: JSON.stringify({
            instruction:
              "합성 고객 요청을 분류하세요. 기한·금액을 변경하거나 변경을 약속하지 마세요.",
            kind: request.kind,
            request: request.text,
          }),
        },
        signal,
      );
      const result = supportSchema.parse(JSON.parse(response.text));
      if (result.evidenceIds.length) throw new DomainError("AI_UNKNOWN_EVIDENCE", 502);
      return transaction(db, () => {
        signal.throwIfAborted();
        assertJob(db, job, clock.now());
        db.prepare(
          "UPDATE support_requests SET route=?,status='AWAITING_REVIEW',explanation=?,error_code=NULL WHERE id=?",
        ).run(result.route, JSON.stringify(result), request.id);
        const day = businessDate(clock.now());
        const sent = db
          .prepare(
            "SELECT 1 FROM mock_messages WHERE application_id=? AND business_date=? AND state='SENT'",
          )
          .get(job.applicationId, day);
        db.prepare("INSERT OR IGNORE INTO mock_messages VALUES (?,?,?,?,?,?,?,?)").run(
          randomUUID(),
          request.id,
          job.applicationId,
          result.route,
          templates[result.route],
          day,
          sent ? "SUPPRESSED" : "SENT",
          sent ? "DAILY_LIMIT" : null,
        );
        return request.id;
      });
    } catch (error) {
      db.prepare(
        "UPDATE support_requests SET status='AWAITING_HUMAN',error_code=? WHERE id=? AND status<>'REVIEWED'",
      ).run(error instanceof DomainError ? error.code : "AI_RESPONSE_FAILED", request.id);
      throw error;
    }
  };
}
