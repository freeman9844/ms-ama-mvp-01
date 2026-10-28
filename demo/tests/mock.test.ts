import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { startTestSystem } from "./helpers/system.js";
import { consentInput } from "./helpers/consent.js";

let h: Awaited<ReturnType<typeof startTestSystem>>;
beforeEach(async () => {
  h = await startTestSystem();
});
afterEach(async () => {
  await h.close();
});
const pageSchema = z.object({
  nextCursor: z.string().nullable(),
  snapshotId: z.string(),
  totalCount: z.number(),
  balances: z.object({ openingKrw: z.number(), closingKrw: z.number() }),
  items: z.array(z.object({ id: z.string(), businessId: z.string(), amountKrw: z.number() })),
});

it("원천 HTTP는 서비스 토큰 없이는 접근을 거부한다", async () => {
  expect((await fetch(`${h.mockUrl}/v1/bank/transactions`)).status).toBe(401);
});

it("첫 페이지 뒤 원천 버전이 바뀌면 혼합 snapshot을 거부한다", async () => {
  const grant = await h.request("shop-a", "POST", "/api/consents", consentInput);
  const { id } = z.object({ id: z.string() }).parse(grant.body);
  const query = { ...consentInput, consentId: id, businessId: "shop-a" };
  const first = pageSchema.parse(await (await h.sourceRequest("BANK", query, null)).json());
  h.sourceDb.prepare("UPDATE source_state SET version=version+1 WHERE id=1").run();
  expect((await h.sourceRequest("BANK", query, first.nextCursor)).status).toBe(409);
});

it("조회기간에 거래가 없으면 완전한 빈 페이지를 반환한다", async () => {
  const grant = await h.request("shop-a", "POST", "/api/consents", consentInput);
  const { id } = z.object({ id: z.string() }).parse(grant.body);
  const query = {
    ...consentInput,
    consentId: id,
    businessId: "shop-a",
    from: "2026-10-26T00:00:00+09:00",
    to: "2026-10-27T00:00:00+09:00",
  };
  const page = pageSchema.parse(await (await h.sourceRequest("BANK", query, null)).json());
  expect(page.items).toEqual([]);
  expect(page.totalCount).toBe(0);
  expect(page.nextCursor).toBeNull();
  expect(page.balances).toEqual({ openingKrw: 3_000_000, closingKrw: 3_000_000 });
});

it("페이지를 모두 수집하면 원천 잔액과 일치한다", async () => {
  const grant = await h.request("shop-a", "POST", "/api/consents", consentInput);
  expect(grant.status).toBe(201);
  const { id } = z.object({ id: z.string() }).parse(grant.body);
  const query = { ...consentInput, consentId: id, businessId: "shop-a" };
  let cursor: string | null = null;
  let sum = 0;
  let count = 0;
  do {
    const response = await h.sourceRequest("BANK", query, cursor);
    expect(response.status).toBe(200);
    const page = pageSchema.parse(await response.json());
    sum += page.items.reduce((n, row) => n + row.amountKrw, 0);
    count += page.items.length;
    expect(page.items.every((row) => row.businessId === "shop-a")).toBe(true);
    expect(page.balances).toEqual({ openingKrw: 1_000_000, closingKrw: 3_000_000 });
    cursor = page.nextCursor;
    if (!cursor) expect(count).toBe(page.totalCount);
  } while (cursor);
  expect(sum).toBe(2_000_000);
});

it("cursor는 다른 사업자와 재사용할 수 없고 매 페이지 동의를 검사한다", async () => {
  const grant = await h.request("shop-a", "POST", "/api/consents", consentInput);
  expect(grant.status).toBe(201);
  const { id } = z.object({ id: z.string() }).parse(grant.body);
  const query = { ...consentInput, consentId: id, businessId: "shop-a" };
  const first = await h.sourceRequest("BANK", query, null);
  expect(first.status).toBe(200);
  const page = pageSchema.parse(await first.json());
  expect(page.nextCursor).not.toBeNull();
  expect(
    (
      await h.sourceRequest(
        "BANK",
        {
          ...query,
          businessId: "shop-b",
        },
        page.nextCursor,
      )
    ).status,
  ).toBe(403);
  h.clock.set(new Date(consentInput.validUntil));
  expect((await h.sourceRequest("BANK", query, page.nextCursor)).status).toBe(403);
});
