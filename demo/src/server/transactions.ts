import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DomainError } from "./errors.js";

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function idempotent<T>(
  db: DatabaseSync,
  actorId: string,
  route: string,
  key: string | undefined,
  body: unknown,
  schema: z.ZodType<T>,
  work: () => T,
): T {
  const validKey = z.string().min(1).max(120).parse(key);
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return transaction(db, () => {
    const raw = db
      .prepare(
        "SELECT fingerprint, response FROM idempotency_keys WHERE actor_id=? AND route=? AND key=?",
      )
      .get(actorId, route, validKey);
    if (raw) {
      const saved = z.object({ fingerprint: z.string(), response: z.string() }).parse(raw);
      if (saved.fingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return schema.parse(JSON.parse(saved.response));
    }
    const result = schema.parse(work());
    db.prepare("INSERT INTO idempotency_keys VALUES (?, ?, ?, ?, ?)").run(
      actorId,
      route,
      validKey,
      fingerprint,
      JSON.stringify(result),
    );
    return result;
  });
}
