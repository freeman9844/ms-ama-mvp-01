import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { initialTime } from "../domain/clock.js";

export function persistentClock(db: DatabaseSync) {
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('demo_time',?)").run(initialTime);
  return {
    now() {
      return new Date(
        z
          .object({ value: z.string() })
          .parse(db.prepare("SELECT value FROM settings WHERE key='demo_time'").get()).value,
      );
    },
    set(date: Date) {
      db.prepare("INSERT OR REPLACE INTO settings VALUES ('demo_time',?)").run(date.toISOString());
    },
  };
}
