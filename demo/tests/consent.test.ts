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

it("체크하지 않은 동의는 등록하지 않는다", async () => {
  expect(
    (
      await h.request("shop-a", "POST", "/api/consents", {
        ...consentInput,
        accepted: false,
      })
    ).status,
  ).toBe(400);
});

it("다른 사업자의 원천 계좌에는 동의할 수 없다", async () => {
  expect(
    (
      await h.request("shop-a", "POST", "/api/consents", {
        ...consentInput,
        resourceIds: ["bank-shop-b"],
      })
    ).status,
  ).toBe(403);
});

it("현재 동의의 목적과 기간을 내부 API에서도 확인한다", async () => {
  const grant = await h.request("shop-a", "POST", "/api/consents", consentInput);
  expect(grant.status).toBe(201);
  const { id } = z.object({ id: z.string() }).parse(grant.body);
  const query = { ...consentInput, consentId: id, businessId: "shop-a" };
  const authorize = (body: unknown) =>
    h.raw("POST", "/internal/consents/authorize", body, {
      authorization: `Bearer ${h.serviceToken}`,
    });
  expect((await authorize(query)).status).toBe(200);
  expect((await authorize({ ...query, purpose: "MONITORING" })).status).toBe(403);
  expect((await authorize({ ...query, from: "2026-01-01T00:00:00+09:00" })).status).toBe(403);
  h.clock.set(new Date(consentInput.validUntil));
  expect((await authorize(query)).status).toBe(403);
});

it("동의 검사 API는 서비스 인증 없이는 읽을 수 없다", async () => {
  expect((await h.raw("POST", "/internal/consents/authorize", {})).status).toBe(401);
});

it("등록과 무관한 잘못된 날짜는 400이다", async () => {
  expect(
    (
      await h.request("shop-a", "POST", "/api/consents", {
        ...consentInput,
        from: "not-a-date",
      })
    ).status,
  ).toBe(400);
});
