import type { DatabaseSync } from "node:sqlite";
import type { AiPort } from "../copilot/port.js";
import type { Clock } from "../domain/clock.js";
import { initialTime } from "../domain/clock.js";
import { z } from "zod";
import { transaction } from "./transactions.js";
import { generation } from "../workflow/queue.js";
import { DomainError } from "./errors.js";

export function maintenance(db: DatabaseSync) {
  const row = db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();
  return row ? z.object({ value: z.string() }).parse(row).value : "NONE";
}
export function createReset(options: {
  db: DatabaseSync;
  clock: Clock & { set(date: Date): void };
  ai: AiPort;
  sourceUrl: string;
  serviceToken: string;
  stopWork(): Promise<void>;
  startWork(): void;
}) {
  const { db } = options;
  let resetting = false;
  return async () => {
    if (resetting) throw new DomainError("RESET_IN_PROGRESS", 409);
    resetting = true;
    try {
      const next = transaction(db, () => {
        if (maintenance(db) === "NONE") {
          db.prepare("UPDATE settings SET value=? WHERE key='generation'").run(
            String(generation(db) + 1),
          );
          db.prepare(
            "UPDATE jobs SET status='CANCELLED' WHERE status IN ('QUEUED','RUNNING')",
          ).run();
          db.prepare("INSERT OR REPLACE INTO settings VALUES ('maintenance','BLOCKED')").run();
        }
        return generation(db);
      });
      await options.stopWork();
      for (const row of db.prepare("SELECT id FROM ai_sessions").all())
        await options.ai.deleteSession(z.object({ id: z.string() }).parse(row).id);
      const response = await fetch(`${options.sourceUrl}/internal/reset`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ generation: next }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new DomainError("MOCK_RESET_FAILED", 503);
      const source = z.object({ generation: z.number() }).parse(await response.json());
      if (source.generation !== next) throw new DomainError("RESET_GENERATION_MISMATCH", 503);
      db.prepare("INSERT OR REPLACE INTO settings VALUES ('maintenance','MOCK_RESET')").run();
      transaction(db, () => {
        for (const table of [
          "tool_events",
          "ai_sessions",
          "mock_messages",
          "support_reviews",
          "support_requests",
          "repayment_schedules",
          "loans",
          "decisions",
          "jobs",
          "deletion_requests",
          "datasets",
          "applications",
          "consents",
          "idempotency_keys",
          "demo_events",
          "audit_events",
          "sessions",
        ]) {
          db.exec(`DELETE FROM ${table}`);
        }
        options.clock.set(new Date(initialTime));
        db.prepare("INSERT OR REPLACE INTO settings VALUES ('maintenance','APP_RESET')").run();
      });
      options.startWork();
      db.prepare("UPDATE settings SET value='NONE' WHERE key='maintenance'").run();
      return { state: "RESET" as const, generation: next };
    } finally {
      resetting = false;
    }
  };
}
