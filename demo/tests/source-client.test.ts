import { afterEach, expect, it, vi } from "vitest";
import { createSourceClient } from "../src/agents/source-client.js";
import { consentQuerySchema } from "../src/domain/contracts.js";
import { consentInput } from "./helpers/consent.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const query = consentQuerySchema.parse({
  ...consentInput,
  consentId: "consent-a",
  businessId: "shop-a",
});
it("일시적 원천 장애는 제한된 재시도 후 실제 페이지를 반환한다", async () => {
  vi.useFakeTimers();
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return calls < 3
      ? new Response("", { status: 503 })
      : Response.json({
          snapshotId: "bank-1",
          asOf: "2026-10-28T00:00:00+09:00",
          totalCount: 0,
          nextCursor: null,
          items: [],
          balances: { openingKrw: 3_000_000, closingKrw: 3_000_000 },
        });
  });
  const pending = createSourceClient(
    "http://127.0.0.1:3001",
    "service",
    new AbortController().signal,
  ).page(query, null);
  const assertion = expect(pending).resolves.toMatchObject({ snapshotId: "bank-1" });
  await Promise.all([vi.runAllTimersAsync(), assertion]);
  expect(calls).toBe(3);
});
it("동의 거부 응답은 재시도하지 않는다", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return new Response("", { status: 403 });
  });
  await expect(
    createSourceClient("http://127.0.0.1:3001", "service", new AbortController().signal).page(
      query,
      null,
    ),
  ).rejects.toThrow("SOURCE_ACCESS_DENIED");
  expect(calls).toBe(1);
});
