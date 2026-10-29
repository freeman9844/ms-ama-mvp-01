import { afterEach, beforeEach, expect, it } from "vitest";
import { startTestSystem } from "./helpers/system.js";
import { gzipSync } from "node:zlib";

let h: Awaited<ReturnType<typeof startTestSystem>>;
beforeEach(async () => {
  h = await startTestSystem();
});
afterEach(async () => {
  await h.close();
});

it("압축 입력을 파싱하지 않고 명시적으로 거부한다", async () => {
  const response = await fetch(`${h.url}/api/demo-login`, {
    method: "POST",
    headers: {
      origin: h.url,
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: gzipSync(JSON.stringify({ account: "shop-a" })),
  });
  expect(response.status).toBe(415);
});

it("로그인하지 않은 사업자 조회를 거부한다", async () => {
  const response = await fetch(`${h.url}/api/me`);
  expect(response.status).toBe(401);
});

it("다른 origin에서는 데모 로그인도 허용하지 않는다", async () => {
  const response = await fetch(`${h.url}/api/demo-login`, {
    method: "POST",
    headers: { origin: "https://untrusted.example", "content-type": "application/json" },
    body: JSON.stringify({ account: "shop-a" }),
  });
  expect(response.status).toBe(403);
});

it("로그인 요청에 넣은 역할과 사업자 ID를 신뢰하지 않는다", async () => {
  const response = await h.raw("POST", "/api/demo-login", {
    account: "shop-a",
    role: "OPERATOR",
    businessId: "shop-b",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    actor: { id: "shop-a", role: "BORROWER", businessId: "shop-a" },
  });
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
});

it("사업자가 본문의 역할을 바꿔도 사건을 만들 수 없다", async () => {
  const response = await h.request("shop-a", "POST", "/api/demo/events", {
    role: "OPERATOR",
    type: "ADVANCE_TIME",
    days: 1,
  });
  expect(response.status).toBe(403);
});

it("운영자라도 CSRF가 틀리면 변경을 거부한다", async () => {
  const response = await h.request(
    "operator",
    "POST",
    "/api/demo/events",
    { type: "ADVANCE_TIME", days: 1 },
    { "x-csrf-token": "tampered" },
  );
  expect(response.status).toBe(403);
});

it("사업자 세션을 서로 분리하고 로그아웃한 세션을 차단한다", async () => {
  const a = await h.request("shop-a", "GET", "/api/me");
  const b = await h.request("shop-b", "GET", "/api/me");
  expect(a.body).toMatchObject({ actor: { businessId: "shop-a" } });
  expect(b.body).toMatchObject({ actor: { businessId: "shop-b" } });
  expect((await h.request("shop-a", "POST", "/api/logout")).status).toBe(204);
  expect((await h.request("shop-a", "GET", "/api/me")).status).toBe(401);
});
