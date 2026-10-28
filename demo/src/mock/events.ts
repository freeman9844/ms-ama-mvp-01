import { z } from "zod";
import { sourceEventSchema } from "../domain/events.js";
import { sourceRecordSchema } from "../domain/contracts.js";
import { transaction } from "../server/transactions.js";
import { DomainError } from "../server/errors.js";
import { generation } from "../workflow/queue.js";
import type { MockOptions } from "./server.js";

export function applySourceEvent(options: MockOptions, input: unknown) {
  const value = sourceEventSchema.parse(input);
  const { db, clock } = options;
  if (!options.setTime) throw new DomainError("CLOCK_NOT_CONFIGURED", 503);
  const nextTime = transaction(db, () => {
    if (value.generation !== generation(db)) throw new DomainError("GENERATION_CHANGED", 409);
    const previous = db.prepare("SELECT payload FROM source_events WHERE id=?").get(value.event.id);
    if (previous) {
      if (z.object({ payload: z.string() }).parse(previous).payload !== JSON.stringify(value))
        throw new DomainError("EVENT_CONFLICT", 409);
      return value.nextTime;
    }
    if (Date.parse(value.occurredAt) < clock.now().getTime())
      throw new DomainError("STALE_EVENT", 409);
    const event = value.event;
    const insertBank = (amountKrw: number, settlementId: string | null) => {
      const row = sourceRecordSchema.parse({
        id: `${event.id}-bank`,
        kind: "BANK",
        businessId: event.businessId,
        resourceId: `bank-${event.businessId}`,
        occurredAt: value.occurredAt,
        amountKrw,
        category: settlementId ? "OPERATING" : "FINANCING",
        settlementId,
      });
      db.prepare("INSERT INTO source_records VALUES (?,?,?,?)").run(
        row.id,
        row.businessId,
        row.kind,
        JSON.stringify(row),
      );
    };
    if (event.type === "SETTLEMENT_DELAY" || event.type === "SETTLEMENT_PAID") {
      const raw = db
        .prepare("SELECT payload FROM source_records WHERE id=? AND business_id=?")
        .get(event.settlementId, event.businessId);
      if (!raw) throw new DomainError("SETTLEMENT_NOT_FOUND", 404);
      const row = sourceRecordSchema.parse(
        JSON.parse(z.object({ payload: z.string() }).parse(raw).payload),
      );
      if (row.kind !== "PG" || row.status === "PAID")
        throw new DomainError("SETTLEMENT_NOT_UNPAID", 409);
      if (event.type === "SETTLEMENT_DELAY") {
        if (
          Date.parse(event.dueAt) <= Date.parse(row.dueAt) ||
          Date.parse(event.dueAt) < Date.parse(value.occurredAt)
        )
          throw new DomainError("INVALID_SETTLEMENT_DATE", 409);
        row.dueAt = event.dueAt;
      } else {
        row.status = "PAID";
        insertBank(row.netKrw, row.id);
      }
      db.prepare("UPDATE source_records SET payload=? WHERE id=?").run(JSON.stringify(row), row.id);
    }
    if (event.type === "PAYMENT_RECEIVED") {
      if (!value.paymentKrw) throw new DomainError("PAYMENT_AMOUNT_REQUIRED", 400);
      insertBank(-value.paymentKrw, null);
    }
    if (event.type === "SOURCE_FAILURE")
      db.prepare(
        "INSERT INTO source_faults VALUES (?,?) ON CONFLICT(source) DO UPDATE SET remaining=excluded.remaining",
      ).run(event.source, event.requests);
    db.prepare("UPDATE source_state SET version=version+1 WHERE id=1").run();
    db.prepare("INSERT INTO source_events VALUES (?,?)").run(event.id, JSON.stringify(value));
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('demo_time',?)").run(value.nextTime);
    return value.nextTime;
  });
  options.setTime(new Date(Math.max(clock.now().getTime(), Date.parse(nextTime))));
  return { nextTime };
}
