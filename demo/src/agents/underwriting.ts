import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
import type { AiPort } from "../copilot/port.js";
import type { JobHandler } from "../workflow/runner.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertJob, requireActiveConsents } from "../workflow/queue.js";
import { readDataset } from "./assembly.js";
import { assessmentSchema } from "../copilot/schemas.js";
import { transaction } from "../server/transactions.js";
import { DomainError } from "../server/errors.js";
import type { Actor } from "../domain/contracts.js";
import { requireRole } from "../server/auth.js";

export function createUnderwriter(db: DatabaseSync, clock: Clock, ai: AiPort): JobHandler {
  return async (job, signal) => {
    assertJob(db, job, clock.now());
    const app = z
      .object({ dataset_id: z.string() })
      .parse(db.prepare("SELECT dataset_id FROM applications WHERE id=?").get(job.applicationId));
    const data = readDataset(db, app.dataset_id);
    if (data.businessId !== job.businessId) throw new DomainError("AI_DATASET_SCOPE", 403);
    const response = await ai.run(
      {
        role: "UNDERWRITING",
        businessId: job.businessId,
        jobId: job.id,
        dataset: { id: data.id, version: data.version, consentIds: data.consentIds },
        modelId: job.modelId,
        prompt: JSON.stringify({
          summary: "이 합성 신청의 심사 의견을 작성하세요. 최종 승인은 담당자만 합니다.",
          balanceKrw: data.balanceKrw,
          operatingNetKrw: data.operatingNetKrw,
          forecast7: data.forecast7,
          forecast30: data.forecast30,
          evidenceIds: data.records.map((row) => row.id),
        }),
      },
      signal,
    );
    const assessment = assessmentSchema.parse(JSON.parse(response.text));
    const evidence = new Set(data.records.map((row) => row.id));
    if (assessment.factors.some((factor) => factor.evidenceIds.some((id) => !evidence.has(id)))) {
      throw new DomainError("AI_UNKNOWN_EVIDENCE", 502);
    }
    return transaction(db, () => {
      signal.throwIfAborted();
      assertJob(db, job, clock.now());
      if (readDataset(db, data.id).version !== data.version)
        throw new DomainError("STALE_DATASET", 409);
      const id = randomUUID();
      const { version } = z
        .object({ version: z.number() })
        .parse(
          db
            .prepare(
              "SELECT COALESCE(MAX(version),0)+1 AS version FROM assessments WHERE application_id=?",
            )
            .get(job.applicationId),
        );
      db.prepare("INSERT INTO assessments VALUES (?, ?, ?, ?, 'STAGED', ?, ?, ?)").run(
        id,
        job.applicationId,
        data.id,
        version,
        JSON.stringify(assessment),
        response.modelId,
        response.sessionId,
      );
      return id;
    });
  };
}

export const reviewInputSchema = z.object({
  applicationId: z.string(),
  datasetVersion: z.number().int(),
  assessmentVersion: z.number().int(),
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_INFORMATION"]),
  reason: z.string().trim().min(1).max(300),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export function review(db: DatabaseSync, clock: Clock, actor: Actor, input: ReviewInput) {
  requireRole(actor, ["OFFICER"]);
  const value = reviewInputSchema.parse(input);
  return transaction(db, () => {
    const app = z
      .object({
        business_id: z.string(),
        status: z.string(),
        dataset_id: z.string().nullable(),
        dataset_version: z.number(),
        assessment_id: z.string().nullable(),
        assessment_version: z.number(),
        created_at: z.string(),
      })
      .parse(db.prepare("SELECT * FROM applications WHERE id=?").get(value.applicationId));
    if (
      app.status !== "AWAITING_REVIEW" ||
      !app.dataset_id ||
      !app.assessment_id ||
      app.dataset_version !== value.datasetVersion ||
      app.assessment_version !== value.assessmentVersion
    ) {
      throw new DomainError("STALE_REVIEW", 409);
    }
    const data = readDataset(db, app.dataset_id);
    requireActiveConsents(db, data.consentIds, app.business_id, clock.now());
    const invalid = db
      .prepare(
        "SELECT 1 FROM dataset_consents d JOIN consents c ON c.id=d.consent_id WHERE d.dataset_id=? AND d.consent_version<>c.version LIMIT 1",
      )
      .get(data.id);
    if (invalid) throw new DomainError("STALE_REVIEW", 409);
    const decisionId = randomUUID();
    const applicationStatus =
      value.decision === "APPROVE"
        ? "APPROVED"
        : value.decision === "REJECT"
          ? "REJECTED"
          : "NEEDS_INFORMATION";
    db.prepare("INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      decisionId,
      value.applicationId,
      actor.id,
      value.decision,
      value.reason,
      data.version,
      app.assessment_version,
      clock.now().toISOString(),
    );
    db.prepare("UPDATE applications SET status=? WHERE id=?").run(
      applicationStatus,
      value.applicationId,
    );
    if (value.decision === "APPROVE") {
      const loanId = randomUUID();
      db.prepare("INSERT INTO loans VALUES (?, ?, ?, 'ACTIVE')").run(
        loanId,
        value.applicationId,
        app.business_id,
      );
      db.prepare("INSERT INTO repayment_schedules VALUES (?, ?, ?, ?, 'SCHEDULED', 1)").run(
        `${value.applicationId}-loan`,
        loanId,
        new Date(Date.parse(app.created_at) + 10 * 86_400_000).toISOString(),
        1_000_000,
      );
    }
    return { decisionId, applicationStatus };
  });
}
