import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
import { daysBetween } from "../domain/clock.js";
import type { Job } from "./queue.js";
import type { Purpose } from "../domain/contracts.js";
import type { JobHandler } from "./runner.js";
import { z } from "zod";
import { collect } from "../agents/assembly.js";
import { createSourceClient } from "../agents/source-client.js";
import { consentInputSchema } from "../agents/consent.js";
import { consentQuerySchema } from "../domain/contracts.js";
import { DomainError } from "../server/errors.js";
import type { ScheduledFlow } from "../domain/forecast.js";
import type { AiRequest } from "../copilot/port.js";
import { assertJob, getJob } from "./queue.js";
import { readDataset } from "../agents/assembly.js";

export function authorizeAiRequest(db: DatabaseSync, clock: Clock, request: AiRequest) {
  const job = getJob(db, request.jobId);
  assertJob(db, job, clock.now());
  const expected =
    job.kind === "UNDERWRITE"
      ? "UNDERWRITING"
      : job.kind === "MONITOR"
        ? "WARNING"
        : job.kind === "SUPPORT"
          ? "COLLECTIONS"
          : null;
  if (
    request.businessId !== job.businessId ||
    request.modelId !== job.modelId ||
    request.role !== expected
  )
    throw new DomainError("AI_JOB_SCOPE", 403);
  if (request.dataset) {
    const data = readDataset(db, request.dataset.id);
    if (
      data.businessId !== job.businessId ||
      data.applicationId !== job.applicationId ||
      data.version !== request.dataset.version ||
      data.consentIds.some((id) => !job.consentIds.includes(id))
    ) {
      throw new DomainError("AI_DATASET_SCOPE", 403);
    }
  } else if (job.kind !== "SUPPORT") throw new DomainError("AI_DATASET_REQUIRED", 403);
}

export function createAssembler(
  db: DatabaseSync,
  clock: Clock,
  sourceUrl: string,
  token: string,
): JobHandler {
  return async (job, signal) => {
    const input = assemblyInput(db, clock, job, "ASSESSMENT");
    db.prepare("UPDATE applications SET status='COLLECTING' WHERE id=?").run(job.applicationId);
    return (await collect(db, clock, createSourceClient(sourceUrl, token, signal), input, signal))
      .id;
  };
}

export function assemblyInput(db: DatabaseSync, clock: Clock, job: Job, purpose: Purpose) {
  if (!job.applicationId) throw new DomainError("APPLICATION_REQUIRED", 400);
  const queries = job.consentIds.map((id) => {
    const row = z
      .object({ payload: z.string() })
      .parse(db.prepare("SELECT payload FROM consents WHERE id=?").get(id));
    const consent = consentInputSchema.parse(JSON.parse(row.payload));
    return consentQuerySchema.parse({
      ...consent,
      consentId: id,
      businessId: job.businessId,
      to:
        consent.source === "BANK"
          ? new Date(Math.min(Date.parse(consent.to), clock.now().getTime())).toISOString()
          : consent.to,
    });
  });
  const createdAt = z
    .object({ created_at: z.string() })
    .parse(
      db.prepare("SELECT created_at FROM applications WHERE id=?").get(job.applicationId),
    ).created_at;
  const elapsed = daysBetween(new Date(createdAt), clock.now());
  const scheduledFlows: ScheduledFlow[] = [
    {
      id: "payroll",
      day: Math.max(0, 5 - elapsed),
      amountKrw: -6_000_000,
      certainty: elapsed <= 5 ? "CONFIRMED" : "UNKNOWN",
    },
    {
      id: "loan",
      day: Math.max(0, 10 - elapsed),
      amountKrw: -1_000_000,
      certainty: elapsed <= 10 ? "CONFIRMED" : "UNKNOWN",
    },
  ];
  if (purpose === "MONITORING") {
    scheduledFlows.pop();
    for (const raw of db
      .prepare(
        "SELECT s.* FROM repayment_schedules s JOIN loans l ON l.id=s.loan_id WHERE l.application_id=? AND s.status<>'PAID'",
      )
      .all(job.applicationId)) {
      const schedule = z
        .object({ id: z.string(), due_at: z.string(), amount_krw: z.number() })
        .parse(raw);
      const day = daysBetween(clock.now(), new Date(schedule.due_at));
      scheduledFlows.push({
        id: schedule.id,
        day: Math.max(0, day),
        amountKrw: -schedule.amount_krw,
        certainty: day >= 0 ? "CONFIRMED" : "UNKNOWN",
      });
    }
  }
  return {
    job,
    applicationId: job.applicationId,
    businessId: job.businessId,
    purpose,
    queries,
    scheduledFlows,
  };
}
