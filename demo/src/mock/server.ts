import express from "express";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../domain/clock.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  consentQuerySchema,
  sourceRecordSchema,
  type ConsentQuery,
  type Source,
  type SourcePage,
} from "../domain/contracts.js";
import { serviceAuthentication } from "../server/auth.js";
import { DomainError, errorHandler, handler } from "../server/errors.js";
import { applySourceEvent } from "./events.js";

export type MockOptions = {
  db: DatabaseSync;
  clock: Clock;
  serviceToken: string;
  appUrl: string;
  setTime?: (date: Date) => void;
};
export function createMockApp(options: MockOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use(serviceAuthentication(options.serviceToken));
  app.use(express.json({ limit: "32kb", inflate: false }));
  app.post("/internal/events", (req, res) => res.json(applySourceEvent(options, req.body)));
  const paths: Record<Source, string> = {
    BANK: "/v1/bank/transactions",
    PG: "/v1/pg/settlements",
    TAX: "/v1/tax/documents",
  };
  for (const source of ["BANK", "PG", "TAX"] as const) {
    app.get(
      paths[source],
      handler(async (req, res) => {
        const query = consentQuerySchema.parse(JSON.parse(z.string().parse(req.query.query)));
        if (source !== query.source) throw new DomainError("SOURCE_MISMATCH", 400);
        await checkConsent(options, query);
        const fault = options.db
          .prepare("UPDATE source_faults SET remaining=remaining-1 WHERE source=? AND remaining>0")
          .run(source);
        if (fault.changes) throw new DomainError("SOURCE_UNAVAILABLE", 503);
        const version = z
          .object({ version: z.number() })
          .parse(options.db.prepare("SELECT version FROM source_state WHERE id=1").get()).version;
        const queryHash = createHash("sha256").update(JSON.stringify(query)).digest("hex");
        let offset = 0;
        if (req.query.cursor) {
          const cursor = readCursor(z.string().parse(req.query.cursor), options.serviceToken);
          if (cursor.queryHash !== queryHash) throw new DomainError("CURSOR_SCOPE", 400);
          if (cursor.version !== version) throw new DomainError("SOURCE_SNAPSHOT_CHANGED", 409);
          offset = cursor.offset;
        }
        if (source === "BANK" && Date.parse(query.to) > options.clock.now().getTime()) {
          throw new DomainError("FUTURE_BANK_QUERY", 400);
        }
        const all = options.db
          .prepare("SELECT payload FROM source_records WHERE business_id = ? AND kind = ?")
          .all(query.businessId, source)
          .map((raw) =>
            sourceRecordSchema.parse(
              JSON.parse(z.object({ payload: z.string() }).parse(raw).payload),
            ),
          )
          .filter((row) => query.resourceIds.includes(row.resourceId))
          .sort(
            (a, b) =>
              Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
          );
        const records = all.filter((row) =>
          source === "BANK"
            ? Date.parse(row.occurredAt) >= Date.parse(query.from) &&
              Date.parse(row.occurredAt) < Date.parse(query.to)
            : row.kind === "TAX"
              ? Date.parse(row.periodStart) >= Date.parse(query.from) &&
                Date.parse(row.periodEnd) <= Date.parse(query.to)
              : Date.parse(row.occurredAt) <= options.clock.now().getTime(),
        );
        const sumBefore = (time: string) =>
          all.reduce(
            (sum, row) =>
              row.kind === "BANK" && Date.parse(row.occurredAt) < Date.parse(time)
                ? sum + row.amountKrw
                : sum,
            1_000_000,
          );
        const nextOffset = offset + 5;
        const page: SourcePage = {
          snapshotId: `${source}-${version}-${queryHash}`,
          asOf: options.clock.now().toISOString(),
          totalCount: records.length,
          items: records.slice(offset, nextOffset),
          nextCursor:
            nextOffset < records.length
              ? signCursor({ queryHash, version, offset: nextOffset }, options.serviceToken)
              : null,
          balances:
            source === "BANK"
              ? { openingKrw: sumBefore(query.from), closingKrw: sumBefore(query.to) }
              : null,
        };
        await checkConsent(options, query);
        res.json(page);
      }),
    );
  }
  app.use(errorHandler);
  return app;
}

async function checkConsent(options: MockOptions, query: ConsentQuery) {
  const response = await fetch(`${options.appUrl}/internal/consents/authorize`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.serviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new DomainError("CONSENT_INACTIVE", response.status === 403 ? 403 : 503);
}

const cursorSchema = z.object({
  queryHash: z.string(),
  version: z.number().int(),
  offset: z.number().int().nonnegative(),
});
function signCursor(value: z.infer<typeof cursorSchema>, token: string) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", token).update(payload).digest("hex")}`;
}
function readCursor(value: string, token: string) {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) throw new DomainError("INVALID_CURSOR", 400);
  const expected = createHmac("sha256", token).update(payload).digest("hex");
  if (
    Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new DomainError("INVALID_CURSOR", 400);
  }
  return cursorSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
}
