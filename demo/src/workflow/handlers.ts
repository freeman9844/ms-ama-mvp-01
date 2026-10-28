import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
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
    const elapsed = Math.floor((clock.now().getTime() - Date.parse(createdAt)) / 86_400_000);
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
    db.prepare("UPDATE applications SET status='COLLECTING' WHERE id=?").run(job.applicationId);
    const ref = await collect(
      db,
      clock,
      createSourceClient(sourceUrl, token, signal),
      {
        job,
        applicationId: job.applicationId,
        businessId: job.businessId,
        purpose: "ASSESSMENT",
        queries,
        scheduledFlows,
      },
      signal,
    );
    return ref.id;
  };
}
