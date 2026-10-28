import { expect, it } from "vitest";
import { createReviewFixture } from "./helpers/review.js";
import { createTestAi } from "./helpers/fake-ai.js";

it("모델 의견만으로 대출을 만들지 않고 사람 승인을 기다린다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    expect(
      h.db.prepare("SELECT status FROM applications WHERE id=?").get(h.applicationId),
    ).toMatchObject({ status: "AWAITING_REVIEW" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM loans").get()).toMatchObject({ n: 0 });
    expect((await h.review()).status).toBe(200);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM loans").get()).toMatchObject({ n: 1 });
  } finally {
    await h.close();
  }
});
it("오래된 평가 버전과 사업자 자신의 승인을 거부한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    expect((await h.review({ assessmentVersion: 0 })).status).toBe(409);
    expect((await h.review({}, "shop-a")).status).toBe(403);
  } finally {
    await h.close();
  }
});
it("같은 승인 요청은 같은 결과이며 새 요청으로 중복 대출을 만들지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    const first = await h.review();
    expect((await h.review()).body).toEqual(first.body);
    expect((await h.review({}, "officer", "different-key")).status).toBe(409);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM repayment_schedules").get()).toMatchObject({
      n: 1,
    });
  } finally {
    await h.close();
  }
});
it("심사 후 철회된 자료로 승인할 수 없다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    h.db
      .prepare("UPDATE consents SET status='REVOKED',version=version+1 WHERE id=?")
      .run(h.consentIds[0]!);
    expect((await h.review()).status).toBe(403);
  } finally {
    await h.close();
  }
});
it("모델 실패를 정상 심사로 대체하지 않는다", async () => {
  const ai = createTestAi();
  ai.run = async () => {
    throw new Error("AI_FAILED");
  };
  const h = await createReviewFixture(ai);
  try {
    await expect(h.runAssessment()).rejects.toThrow("AI_FAILED");
    expect((await h.review()).status).toBe(409);
  } finally {
    await h.close();
  }
});
it("존재하지 않는 근거를 참조한 의견을 거부한다", async () => {
  const ai = createTestAi();
  ai.run = async (request) => ({
    text: JSON.stringify({
      recommendation: "REVIEW",
      factors: [{ label: "위조 근거", evidenceIds: ["other-business-data"] }],
      uncertainties: [],
      explanation: "검증되어야 합니다.",
    }),
    modelId: request.modelId,
    sessionId: "test",
    usage: null,
  });
  const h = await createReviewFixture(ai);
  try {
    await expect(h.runAssessment()).rejects.toThrow("AI_UNKNOWN_EVIDENCE");
  } finally {
    await h.close();
  }
});
