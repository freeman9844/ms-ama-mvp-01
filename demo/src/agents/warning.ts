import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
import type { AiPort } from "../copilot/port.js";
import type { JobHandler } from "../workflow/runner.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertJob } from "../workflow/queue.js";
import { assemblyInput } from "../workflow/handlers.js";
import { collect, readDataset } from "./assembly.js";
import { createSourceClient } from "./source-client.js";
import { transaction } from "../server/transactions.js";
import { warningSchema } from "../copilot/schemas.js";
import { DomainError } from "../server/errors.js";
import { businessDate } from "../domain/clock.js";

export function createMonitor(
  db: DatabaseSync,
  clock: Clock,
  ai: AiPort,
  sourceUrl: string,
  token: string,
): JobHandler {
  return async (job, signal) => {
    assertJob(db, job, clock.now());
    if (
      !db
        .prepare("SELECT 1 FROM loans WHERE application_id=? AND business_id=? AND status='ACTIVE'")
        .get(job.applicationId, job.businessId)
    )
      throw new DomainError("ACTIVE_LOAN_REQUIRED", 409);
    let previous = job.referenceId
      ? db
          .prepare("SELECT id,dataset_id,explanation_status FROM alerts WHERE id=?")
          .get(job.referenceId)
      : undefined;
    if (!previous) {
      const ref = await collect(
        db,
        clock,
        createSourceClient(sourceUrl, token, signal),
        assemblyInput(db, clock, job, "MONITORING"),
        signal,
      );
      previous = transaction(db, () => {
        signal.throwIfAborted();
        assertJob(db, job, clock.now());
        db.prepare("UPDATE datasets SET validation_status='VALID' WHERE id=?").run(ref.id);
        const data = readDataset(db, ref.id);
        if (data.forecast30.minimumKrw >= 0) {
          db.prepare(
            "UPDATE alerts SET state='RESOLVED' WHERE application_id=? AND state='ACTIVE'",
          ).run(job.applicationId);
          return undefined;
        }
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              day: businessDate(clock.now()),
              records: data.records,
              forecast: data.forecast30,
              consentIds: data.consentIds,
            }),
          )
          .digest("hex");
        db.prepare(
          "INSERT OR IGNORE INTO alerts VALUES (?,?,?,?,?,'ACTIVE',?,'PENDING',NULL,NULL)",
        ).run(
          randomUUID(),
          job.applicationId,
          data.id,
          fingerprint,
          "LIQUIDITY_SHORTFALL",
          data.forecast30.minimumKrw,
        );
        const alert = z
          .object({ id: z.string(), dataset_id: z.string(), explanation_status: z.string() })
          .parse(
            db
              .prepare(
                "SELECT id,dataset_id,explanation_status FROM alerts WHERE application_id=? AND fingerprint=?",
              )
              .get(job.applicationId, fingerprint),
          );
        db.prepare("UPDATE jobs SET reference_id=? WHERE id=?").run(alert.id, job.id);
        return alert;
      });
      if (!previous) return ref.id;
    }
    const alert = z
      .object({ id: z.string(), dataset_id: z.string(), explanation_status: z.string() })
      .parse(previous);
    if (alert.explanation_status === "COMPLETE") return alert.id;
    const data = readDataset(db, alert.dataset_id);
    try {
      const response = await ai.run(
        {
          role: "WARNING",
          jobId: job.id,
          businessId: job.businessId,
          modelId: job.modelId,
          dataset: { id: data.id, version: data.version, consentIds: data.consentIds },
          prompt: JSON.stringify({
            instruction:
              "합성 유동성 경보를 설명하세요. 예상 부족은 실제 미납이 아니며 추심을 시작하지 않습니다.",
            forecast7: data.forecast7,
            forecast30: data.forecast30,
            evidenceIds: data.records.map((r) => r.id),
          }),
        },
        signal,
      );
      const result = warningSchema.parse(JSON.parse(response.text));
      if (result.evidenceIds.some((id) => !data.records.some((row) => row.id === id)))
        throw new DomainError("AI_UNKNOWN_EVIDENCE", 502);
      return transaction(db, () => {
        signal.throwIfAborted();
        assertJob(db, job, clock.now());
        db.prepare(
          "UPDATE alerts SET explanation_status='COMPLETE',explanation=?,error_code=NULL WHERE id=?",
        ).run(JSON.stringify(result), alert.id);
        return alert.id;
      });
    } catch (error) {
      db.prepare("UPDATE alerts SET explanation_status='FAILED',error_code=? WHERE id=?").run(
        error instanceof DomainError ? error.code : "AI_RESPONSE_FAILED",
        alert.id,
      );
      throw error;
    }
  };
}
