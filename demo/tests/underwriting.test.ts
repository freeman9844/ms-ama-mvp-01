import { expect, it } from "vitest";
import { createReviewFixture } from "./helpers/review.js";
import { createTestAi } from "./helpers/fake-ai.js";
import { claim, enqueue, fail, getJob } from "../src/workflow/queue.js";
import { createUnderwriter } from "../src/agents/underwriting.js";
import { DomainError } from "../src/server/errors.js";
import { z } from "zod";

it("완료된 작업의 늦은 오류는 사람의 결정 상태를 변경하지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    const { id } = z
      .object({ id: z.string() })
      .parse(h.db.prepare("SELECT id FROM jobs WHERE kind='ASSEMBLE'").get());
    fail(h.db, getJob(h.db, id), new DomainError("BALANCE_MISMATCH", 502));
    expect(
      h.db.prepare("SELECT status FROM applications WHERE id=?").get(h.applicationId),
    ).toMatchObject({ status: "APPROVED" });
  } finally {
    await h.close();
  }
});

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
it.each(["APPROVE", "REJECT", "REQUEST_INFORMATION"])(
  "사람의 %s 결정 후 과거 실패 작업은 재시도와 결과 저장을 할 수 없다",
  async (decision) => {
    const ai = createTestAi();
    const run = ai.run;
    const h = await createReviewFixture(ai);
    try {
      ai.run = async () => {
        throw new DomainError("AI_INVALID_OUTPUT", 502);
      };
      await expect(h.runAssessment()).rejects.toThrow("AI_INVALID_OUTPUT");
      const old = z
        .object({ id: z.string() })
        .parse(h.db.prepare("SELECT id FROM jobs WHERE kind='UNDERWRITE'").get());
      expect(
        (
          await h.request(
            "shop-a",
            "POST",
            `/api/jobs/${old.id}/retry`,
            {},
            { "idempotency-key": "retry-once" },
          )
        ).status,
      ).toBe(202);
      ai.run = run;
      await h.runAssessment();
      expect((await h.review({ decision })).status).toBe(200);
      expect(
        (
          await h.request(
            "shop-a",
            "POST",
            `/api/jobs/${old.id}/retry`,
            {},
            { "idempotency-key": "retry-old" },
          )
        ).status,
      ).toBe(409);
      enqueue(h.db, {
        kind: "UNDERWRITE",
        applicationId: h.applicationId,
        businessId: "shop-a",
        consentIds: h.consentIds,
        modelId: "test-model",
        referenceId: null,
      });
      const late = claim(h.db, Date.now(), ["UNDERWRITE"]);
      if (!late) throw new Error("Missing late job");
      await expect(
        createUnderwriter(h.db, h.clock, ai)(late, new AbortController().signal),
      ).rejects.toThrow("JOB_OBSOLETE");
    } finally {
      await h.close();
    }
  },
);
