import { expect, it } from "vitest";
import { startTestSystem } from "./helpers/system.js";
import { createReviewFixture } from "./helpers/review.js";
import { consentInput } from "./helpers/consent.js";

it("동의 등록 응답을 잃고 같은 키로 재시도해도 동의를 중복 등록하지 않는다", async () => {
  const h = await startTestSystem();
  try {
    const headers = { "idempotency-key": "grant-browser-retry" };
    const first = await h.request("shop-a", "POST", "/api/consents", consentInput, headers);
    const repeated = await h.request("shop-a", "POST", "/api/consents", consentInput, headers);
    expect(repeated.body).toEqual(first.body);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM consents").get()).toMatchObject({ n: 1 });
  } finally {
    await h.close();
  }
});
it("읽기 화면도 사업자를 격리하고 내부 평가·경보는 사업자에게 공개하지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    await h.request(
      "shop-a",
      "POST",
      "/api/support-requests",
      {
        applicationId: h.applicationId,
        kind: "GENERAL_INQUIRY",
        text: "합성 문의",
      },
      { "idempotency-key": "private-request" },
    );
    for (const path of ["/api/loans", "/api/support-requests", "/api/timeline"])
      expect((await h.request("shop-b", "GET", path)).body).toEqual([]);
    expect((await h.request("shop-a", "GET", "/api/alerts")).status).toBe(403);
    expect(
      (await h.request("shop-a", "GET", `/api/applications/${h.applicationId}/assessment`)).status,
    ).toBe(403);
  } finally {
    await h.close();
  }
});
