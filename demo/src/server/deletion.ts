import type { DatabaseSync } from "node:sqlite";
import type { AiPort } from "../copilot/port.js";
import type { JobHandler } from "../workflow/runner.js";
import { z } from "zod";
import { assertJob } from "../workflow/queue.js";
import { transaction } from "./transactions.js";
import { DomainError } from "./errors.js";

export function createDeletionHandler(db: DatabaseSync, ai: AiPort): JobHandler {
  return async (job, signal) => {
    assertJob(db, job, new Date());
    if (!job.referenceId) throw new DomainError("DELETION_REFERENCE_REQUIRED", 400);
    const consentId = job.referenceId;
    const deletion = z
      .object({ state: z.string() })
      .parse(db.prepare("SELECT state FROM deletion_requests WHERE consent_id=?").get(consentId));
    if (deletion.state === "COMPLETE") return consentId;
    transaction(db, () => {
      assertJob(db, job, new Date());
      db.prepare(
        "UPDATE deletion_requests SET state='DELETING',job_id=?,error_code=NULL WHERE consent_id=?",
      ).run(job.id, consentId);
      db.prepare(
        "UPDATE decisions SET reason='근거 자료 삭제됨' WHERE application_id IN (SELECT application_id FROM assessments WHERE dataset_id IN (SELECT dataset_id FROM dataset_consents WHERE consent_id=?))",
      ).run(consentId);
      db.prepare(
        "UPDATE applications SET dataset_id=NULL,assessment_id=NULL WHERE dataset_id IN (SELECT dataset_id FROM dataset_consents WHERE consent_id=?)",
      ).run(consentId);
      db.prepare(
        "DELETE FROM datasets WHERE id IN (SELECT dataset_id FROM dataset_consents WHERE consent_id=?)",
      ).run(consentId);
    });
    const sessions = db
      .prepare(
        "SELECT id FROM ai_sessions WHERE business_id=? AND EXISTS (SELECT 1 FROM json_each(ai_sessions.consent_ids) WHERE value=?)",
      )
      .all(job.businessId, consentId)
      .map((raw) => z.object({ id: z.string() }).parse(raw).id);
    const failures: unknown[] = [];
    for (const id of sessions) {
      signal.throwIfAborted();
      assertJob(db, job, new Date());
      try {
        await ai.deleteSession(id);
        transaction(db, () => {
          assertJob(db, job, new Date());
          db.prepare("DELETE FROM tool_events WHERE session_id=?").run(id);
          db.prepare("DELETE FROM ai_sessions WHERE id=?").run(id);
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      db.prepare(
        "UPDATE deletion_requests SET state='CLEANUP_FAILED',error_code='AI_CLEANUP_FAILED' WHERE consent_id=?",
      ).run(consentId);
      throw new DomainError("AI_CLEANUP_FAILED", 502);
    }
    return transaction(db, () => {
      signal.throwIfAborted();
      assertJob(db, job, new Date());
      db.prepare(
        "UPDATE deletion_requests SET state='COMPLETE',error_code=NULL WHERE consent_id=?",
      ).run(consentId);
      return consentId;
    });
  };
}
