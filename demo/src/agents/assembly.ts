import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../domain/clock.js";
import { daysBetween } from "../domain/clock.js";
import {
  sourcePageSchema,
  sourceRecordSchema,
  type ConsentQuery,
  type Purpose,
  type SourcePage,
  type SourceRecord,
} from "../domain/contracts.js";
import {
  forecast,
  forecastSchema,
  scheduledFlowSchema,
  type ScheduledFlow,
} from "../domain/forecast.js";
import { addKrw } from "../domain/money.js";
import { authorize } from "./consent.js";
import { DomainError } from "../server/errors.js";
import { assertJob, type Job } from "../workflow/queue.js";

export type DatasetRef = { id: string; version: number; consentIds: string[] };
export type AssemblyInput = {
  job: Job;
  applicationId: string;
  businessId: string;
  purpose: Purpose;
  queries: ConsentQuery[];
  scheduledFlows: ScheduledFlow[];
};
export type SourceClient = {
  page(query: ConsentQuery, cursor: string | null): Promise<SourcePage>;
};
export const datasetSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  consentIds: z.array(z.string()),
  businessId: z.string(),
  applicationId: z.string(),
  asOf: z.string(),
  balanceKrw: z.number().int().safe(),
  operatingNetKrw: z.number().int().safe(),
  records: z.array(sourceRecordSchema),
  forecast7: forecastSchema,
  forecast30: forecastSchema,
  sourceSnapshotIds: z.array(z.string()),
  scheduledFlows: z.array(scheduledFlowSchema),
});
export type Dataset = z.infer<typeof datasetSchema>;
export async function collect(
  db: DatabaseSync,
  clock: Clock,
  source: SourceClient,
  input: AssemblyInput,
  signal: AbortSignal,
): Promise<DatasetRef> {
  assertJob(db, input.job, clock.now());
  if (
    input.queries.length !== 3 ||
    new Set(input.queries.map((q) => q.source)).size !== 3 ||
    input.queries.some((q) => q.businessId !== input.businessId || q.purpose !== input.purpose)
  ) {
    throw new DomainError("INVALID_ASSEMBLY_SCOPE", 400);
  }
  const proofs = input.queries.map((query) => authorize(db, query, clock.now()));
  const records: SourceRecord[] = [];
  const snapshots: string[] = [];
  let balanceKrw: number | undefined;
  const asOf = clock.now().toISOString();
  for (const query of input.queries) {
    let cursor: string | null = null;
    let first: SourcePage | undefined;
    const seenCursors = new Set<string>();
    const byId = new Map<string, SourceRecord>();
    do {
      signal.throwIfAborted();
      assertJob(db, input.job, clock.now());
      authorize(db, query, clock.now());
      const page = sourcePageSchema.parse(await source.page(query, cursor));
      if (!first) first = page;
      if (
        page.asOf !== asOf ||
        page.snapshotId !== first.snapshotId ||
        page.asOf !== first.asOf ||
        page.totalCount !== first.totalCount ||
        JSON.stringify(page.balances) !== JSON.stringify(first.balances)
      ) {
        throw new DomainError("SOURCE_SNAPSHOT_CHANGED", 409);
      }
      for (const row of page.items) {
        if (
          row.businessId !== input.businessId ||
          row.kind !== query.source ||
          !query.resourceIds.includes(row.resourceId)
        ) {
          throw new DomainError("SOURCE_SCOPE", 403);
        }
        const key = `${row.kind}:${row.resourceId}:${row.id}`;
        const previous = byId.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
          throw new DomainError("CONFLICTING_RECORD", 422);
        }
        byId.set(key, row);
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new DomainError("REPEATED_CURSOR", 502);
        seenCursors.add(cursor);
      }
      if (seenCursors.size > 1_000 || byId.size > 50_000) {
        throw new DomainError("SOURCE_LIMIT", 502);
      }
    } while (cursor);
    if (!first || byId.size !== first.totalCount) throw new DomainError("INCOMPLETE_SOURCE", 502);
    const rows = [...byId.values()];
    if (query.source === "BANK") {
      if (!first.balances) throw new DomainError("MISSING_BALANCE", 422);
      const closing = rows.reduce(
        (sum, row) => (row.kind === "BANK" ? addKrw(sum, row.amountKrw) : sum),
        first.balances.openingKrw,
      );
      if (closing !== first.balances.closingKrw) throw new DomainError("BALANCE_MISMATCH", 422);
      balanceKrw = closing;
    }
    snapshots.push(first.snapshotId);
    records.push(...rows);
  }
  if (balanceKrw === undefined) throw new DomainError("MISSING_BANK_DATA", 422);
  const flows = [...input.scheduledFlows];
  for (const row of records) {
    if (row.kind !== "PG" || row.status === "PAID") continue;
    const day = daysBetween(new Date(asOf), new Date(row.dueAt));
    flows.push({
      id: row.id,
      day: Math.max(0, day),
      amountKrw: row.netKrw,
      certainty: row.status === "UNPAID" && day >= 0 ? "CONFIRMED" : "UNKNOWN",
    });
  }
  const forecast7 = forecast(balanceKrw, flows, 7);
  const forecast30 = forecast(balanceKrw, flows, 30);
  const operatingNetKrw = records.reduce(
    (sum, row) =>
      row.kind === "BANK" && row.category === "OPERATING" ? addKrw(sum, row.amountKrw) : sum,
    0,
  );
  signal.throwIfAborted();
  if (clock.now().toISOString() !== asOf) throw new DomainError("SOURCE_SNAPSHOT_CHANGED", 409);
  db.exec("BEGIN IMMEDIATE");
  try {
    assertJob(db, input.job, clock.now());
    input.queries.forEach((query, index) => {
      const proof = authorize(db, query, clock.now());
      if (proof.version !== proofs[index]?.version) throw new DomainError("CONSENT_CHANGED", 403);
    });
    const { version } = z
      .object({ version: z.number() })
      .parse(
        db
          .prepare(
            "SELECT COALESCE(MAX(version),0)+1 AS version FROM datasets WHERE application_id=?",
          )
          .get(input.applicationId),
      );
    const result: Dataset = {
      id: randomUUID(),
      version,
      consentIds: proofs.map((p) => p.id),
      businessId: input.businessId,
      applicationId: input.applicationId,
      asOf,
      balanceKrw,
      operatingNetKrw,
      records,
      forecast7,
      forecast30,
      sourceSnapshotIds: snapshots,
      scheduledFlows: flows,
    };
    const { records: sourceRecords, ...metadata } = result;
    db.prepare("INSERT INTO datasets VALUES (?, ?, ?, ?, 'STAGED', ?)").run(
      result.id,
      input.applicationId,
      input.businessId,
      version,
      JSON.stringify(metadata),
    );
    for (const proof of proofs)
      db.prepare("INSERT INTO dataset_consents VALUES (?, ?, ?)").run(
        result.id,
        proof.id,
        proof.version,
      );
    for (const row of sourceRecords)
      db.prepare("INSERT INTO source_records VALUES (?, ?, ?, ?, ?)").run(
        result.id,
        row.kind,
        row.resourceId,
        row.id,
        JSON.stringify(row),
      );
    db.prepare("INSERT INTO forecasts VALUES (?, ?)").run(
      result.id,
      JSON.stringify({ forecast7, forecast30 }),
    );
    db.exec("COMMIT");
    return { id: result.id, version, consentIds: result.consentIds };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function readDataset(db: DatabaseSync, id: string): Dataset {
  const raw = db
    .prepare("SELECT payload FROM datasets WHERE id=? AND validation_status='VALID'")
    .get(id);
  if (!raw) throw new DomainError("DATASET_UNAVAILABLE", 404);
  const { payload } = z.object({ payload: z.string() }).parse(raw);
  const records = db
    .prepare("SELECT payload FROM source_records WHERE dataset_id=?")
    .all(id)
    .map((row) => JSON.parse(z.object({ payload: z.string() }).parse(row).payload));
  return datasetSchema.parse({
    ...z.record(z.string(), z.unknown()).parse(JSON.parse(payload)),
    records,
  });
}
