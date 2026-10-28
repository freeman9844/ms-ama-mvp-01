import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import {
  collect as collectStaged,
  readDataset,
  type AssemblyInput,
  type SourceClient,
} from "../src/agents/assembly.js";
import { consentQuerySchema, sourcePageSchema } from "../src/domain/contracts.js";
import { startTestSystem } from "./helpers/system.js";
import { consentInput } from "./helpers/consent.js";
import { claim, complete } from "../src/workflow/queue.js";

const collect: typeof collectStaged = async (db, clock, source, input, signal) => {
  const ref = await collectStaged(db, clock, source, input, signal);
  if (!complete(db, input.job, ref.id, clock.now())) throw new Error("Job completion rejected");
  return ref;
};

let h: Awaited<ReturnType<typeof startTestSystem>>;
let input: AssemblyInput;
let source: SourceClient;
beforeEach(async () => {
  h = await startTestSystem();
  const queries = [];
  for (const kind of ["BANK", "PG", "TAX"] as const) {
    const grantBody = {
      ...consentInput,
      source: kind,
      resourceIds: [`${kind.toLowerCase()}-shop-a`],
    };
    const grant = await h.request("shop-a", "POST", "/api/consents", grantBody);
    const { id } = z.object({ id: z.string() }).parse(grant.body);
    queries.push(consentQuerySchema.parse({ ...grantBody, consentId: id, businessId: "shop-a" }));
  }
  const submitted = await h.request(
    "shop-a",
    "POST",
    "/api/applications",
    {
      companyName: "합성 가게 A",
      requestedAmountKrw: 10_000_000,
      consentIds: queries.map((query) => query.consentId),
    },
    { "idempotency-key": "assembly-fixture" },
  );
  const { applicationId } = z.object({ applicationId: z.string() }).parse(submitted.body);
  const job = claim(h.db, Date.now());
  if (!job) throw new Error("Missing fixture job");
  input = {
    job,
    applicationId,
    businessId: "shop-a",
    purpose: "ASSESSMENT",
    queries,
    scheduledFlows: [
      { id: "payroll", day: 5, amountKrw: -6_000_000, certainty: "CONFIRMED" },
      { id: "loan", day: 10, amountKrw: -1_000_000, certainty: "CONFIRMED" },
    ],
  };
  source = {
    async page(query, cursor) {
      const response = await h.sourceRequest(query.source, query, cursor);
      if (!response.ok) throw new Error("SOURCE_REJECTED");
      return sourcePageSchema.parse(await response.json());
    },
  };
});
afterEach(async () => {
  await h.close();
});
const signal = () => new AbortController().signal;

it("실제 HTTP 자료로 원천 잔액과 전망을 계산한다", async () => {
  const ref = await collect(h.db, h.clock, source, input, signal());
  const result = readDataset(h.db, ref.id);
  expect(result.balanceKrw).toBe(3_000_000);
  expect(result.operatingNetKrw).toBe(2_000_000);
  expect(result.forecast30.minimumKrw).toBe(1_000_000);
  expect(result.forecast7.minimumKrw).toBe(2_000_000);
});
it("PG가 이미 지급되었다면 전망에서 재합산하지 않는다", async () => {
  const paid: SourceClient = {
    async page(query, cursor) {
      const page = await source.page(query, cursor);
      return {
        ...page,
        items: page.items.map((row) => (row.kind === "PG" ? { ...row, status: "PAID" } : row)),
      };
    },
  };
  const ref = await collect(h.db, h.clock, paid, input, signal());
  expect(readDataset(h.db, ref.id).forecast30.closingKrw).toBe(-4_000_000);
});
it("페이지 누락으로 총 건수가 다르면 결과를 공개하지 않는다", async () => {
  const missing: SourceClient = {
    async page(query, cursor) {
      return { ...(await source.page(query, cursor)), nextCursor: null };
    },
  };
  await expect(collect(h.db, h.clock, missing, input, signal())).rejects.toThrow(
    "INCOMPLETE_SOURCE",
  );
});
it("동일 ID의 다른 내용은 정상 중복으로 취급하지 않는다", async () => {
  const conflict: SourceClient = {
    async page(query, cursor) {
      const page = await source.page(query, cursor);
      const row = page.items[0];
      return row?.kind === "BANK"
        ? {
            ...page,
            items: [...page.items, { ...row, amountKrw: row.amountKrw + 1 }],
          }
        : page;
    },
  };
  await expect(collect(h.db, h.clock, conflict, input, signal())).rejects.toThrow(
    "CONFLICTING_RECORD",
  );
});
it("동일 내용 중복은 한 번만 반영한다", async () => {
  const duplicate: SourceClient = {
    async page(query, cursor) {
      const page = await source.page(query, cursor);
      return { ...page, items: [...page.items, ...page.items] };
    },
  };
  const ref = await collect(h.db, h.clock, duplicate, input, signal());
  expect(readDataset(h.db, ref.id).balanceKrw).toBe(3_000_000);
});
it("반복 cursor는 무한 조회하지 않고 중단한다", async () => {
  const repeat: SourceClient = {
    async page(query) {
      return { ...(await source.page(query, null)), nextCursor: "repeat" };
    },
  };
  await expect(collect(h.db, h.clock, repeat, input, signal())).rejects.toThrow("REPEATED_CURSOR");
});
it("수집 중 동의 철회는 마지막 결과 저장도 차단한다", async () => {
  const revoke: SourceClient = {
    async page(query, cursor) {
      const page = await source.page(query, cursor);
      h.db
        .prepare("UPDATE consents SET status='REVOKED', version=version+1 WHERE id=?")
        .run(query.consentId);
      return page;
    },
  };
  await expect(collect(h.db, h.clock, revoke, input, signal())).rejects.toThrow("CONSENT_INACTIVE");
});
