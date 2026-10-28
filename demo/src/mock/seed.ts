import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { sourceRecordSchema, type SourceRecord } from "../domain/contracts.js";

export function openSourceDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  if (!db.prepare("SELECT id FROM source_records LIMIT 1").get()) seedSource(db);
  return db;
}

export function seedSource(db: DatabaseSync) {
  const insert = db.prepare("INSERT INTO source_records VALUES (?, ?, ?, ?)");
  const save = (input: SourceRecord) => {
    const record = sourceRecordSchema.parse(input);
    insert.run(record.id, record.businessId, record.kind, JSON.stringify(record));
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const businessId of ["shop-a", "shop-b"]) {
      const bank = (
        id: string,
        occurredAt: string,
        amountKrw: number,
        category: "OPERATING" | "INTERNAL_TRANSFER" | "FINANCING" = "OPERATING",
      ) =>
        save({
          id: `${businessId}-${id}`,
          businessId,
          resourceId: `bank-${businessId}`,
          kind: "BANK",
          occurredAt,
          amountKrw,
          category,
          settlementId: null,
        });
      for (let month = 4; month <= 9; month++) {
        const prefix = `2026-${String(month).padStart(2, "0")}`;
        bank(`income-${month}`, `${prefix}-29T09:00:00+09:00`, 2_000_000);
        bank(`cost-${month}`, `${prefix}-29T18:00:00+09:00`, -1_700_000);
      }
      bank("adjustment", "2026-10-20T09:00:00+09:00", 200_000);
      bank("own-in", "2026-10-21T09:00:00+09:00", 500_000, "INTERNAL_TRANSFER");
      bank("own-out", "2026-10-21T10:00:00+09:00", -500_000, "INTERNAL_TRANSFER");
      bank("loan-in", "2026-10-22T09:00:00+09:00", 1_000_000, "FINANCING");
      bank("loan-out", "2026-10-22T10:00:00+09:00", -1_000_000, "FINANCING");
      save({
        id: `${businessId}-settlement`,
        kind: "PG",
        businessId,
        resourceId: `pg-${businessId}`,
        occurredAt: "2026-10-27T12:00:00+09:00",
        netKrw: 5_000_000,
        dueAt: "2026-10-31T00:00:00+09:00",
        status: "UNPAID",
      });
      save({
        id: `${businessId}-tax`,
        kind: "TAX",
        businessId,
        resourceId: `tax-${businessId}`,
        occurredAt: "2026-10-01T00:00:00+09:00",
        periodStart: "2026-04-28T00:00:00+09:00",
        periodEnd: "2026-10-01T00:00:00+09:00",
        reportedRevenueKrw: 12_000_000,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
