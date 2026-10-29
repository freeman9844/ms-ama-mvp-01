import { expect, it } from "vitest";
import { createReviewFixture } from "./helpers/review.js";
import { claim, complete, fail } from "../src/workflow/queue.js";
import { createSupportAgent } from "../src/agents/collections.js";
import { z } from "zod";
import { DomainError } from "../src/server/errors.js";
import { EventEmitter, once } from "node:events";

it("지원 요청은 고정 안내만 보내고 하루 자동 안내를 한 번으로 제한한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    for (const key of ["support-1", "support-2"]) {
      const result = await h.request(
        "shop-a",
        "POST",
        "/api/support-requests",
        {
          applicationId: h.applicationId,
          text: "합성 상환 지원 요청입니다.",
          kind: "PAYMENT_DIFFICULTY",
        },
        { "idempotency-key": key },
      );
      expect(result.status).toBe(202);
      const job = claim(h.db, Date.now(), ["SUPPORT"]);
      if (!job) throw new Error("Missing support job");
      const id = await createSupportAgent(h.db, h.clock, h.ai)(job, new AbortController().signal);
      expect(complete(h.db, job, id, h.clock.now())).toBe(true);
    }
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM mock_messages WHERE state='SENT'").get(),
    ).toMatchObject({ n: 1 });
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM mock_messages WHERE state='SUPPRESSED'").get(),
    ).toMatchObject({ n: 1 });
    expect(h.db.prepare("SELECT version FROM repayment_schedules").get()).toMatchObject({
      version: 1,
    });
  } finally {
    await h.close();
  }
});
it("담당자 검토 완료 후 늦은 모델 재시도가 검토 결과를 덮어쓰지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    const response = await h.request(
      "shop-a",
      "POST",
      "/api/support-requests",
      {
        applicationId: h.applicationId,
        text: "합성 문의",
        kind: "GENERAL_INQUIRY",
      },
      { "idempotency-key": "late-support" },
    );
    const { id } = z.object({ id: z.string() }).parse(response.body);
    let job = claim(h.db, Date.now(), ["SUPPORT"]);
    if (!job) throw new Error("Missing support job");
    const error = new DomainError("AI_TRANSIENT", 503);
    h.ai.run = async () => {
      throw error;
    };
    await expect(
      createSupportAgent(h.db, h.clock, h.ai)(job, new AbortController().signal),
    ).rejects.toThrow();
    fail(h.db, job, error);
    job = claim(h.db, Date.now() + 2_000, ["SUPPORT"]);
    if (!job) throw new Error("Missing retry job");
    const events = new EventEmitter();
    const ready = once(events, "ready");
    const finish = once(events, "finish");
    h.ai.run = async (request) => {
      events.emit("ready");
      await finish;
      return {
        text: JSON.stringify({
          route: "GENERAL_INQUIRY",
          explanation: "합성 응답",
          evidenceIds: [],
        }),
        sessionId: "late",
        modelId: request.modelId,
        usage: null,
      };
    };
    const running = createSupportAgent(h.db, h.clock, h.ai)(job, new AbortController().signal);
    const rejected = expect(running).rejects.toThrow("JOB_INVALIDATED");
    await ready;
    expect(
      (
        await h.request(
          "officer",
          "POST",
          `/api/support-requests/${id}/review`,
          { action: "COMPLETE" },
          { "idempotency-key": "human-first" },
        )
      ).status,
    ).toBe(200);
    events.emit("finish");
    await rejected;
    expect(h.db.prepare("SELECT status FROM support_requests WHERE id=?").get(id)).toMatchObject({
      status: "REVIEWED",
    });
  } finally {
    await h.close();
  }
});
it("지원 모델 실패는 담당자 대기로 남고 기한 변경은 버전 일치 승인만 허용한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    const result = await h.request(
      "shop-a",
      "POST",
      "/api/support-requests",
      {
        applicationId: h.applicationId,
        text: "합성 납부일 조정 요청",
        kind: "PAYMENT_DIFFICULTY",
      },
      { "idempotency-key": "support-review" },
    );
    const { id } = z.object({ id: z.string() }).parse(result.body);
    const job = claim(h.db, Date.now(), ["SUPPORT"]);
    if (!job) throw new Error("Missing support job");
    h.ai.run = async () => {
      throw new DomainError("AI_UNAVAILABLE", 502);
    };
    await expect(
      createSupportAgent(h.db, h.clock, h.ai)(job, new AbortController().signal),
    ).rejects.toThrow("AI_UNAVAILABLE");
    expect(h.db.prepare("SELECT status FROM support_requests WHERE id=?").get(id)).toMatchObject({
      status: "AWAITING_HUMAN",
    });
    const body = {
      action: "CHANGE_DUE_DATE",
      scheduleId: `${h.applicationId}-loan`,
      scheduleVersion: 1,
      dueAt: "2026-11-10T00:00:00+09:00",
    };
    for (const [key, override] of [
      ["stale", { scheduleVersion: 2 }],
      ["too-late", { dueAt: "2026-12-20T00:00:00+09:00" }],
    ] as const)
      expect(
        (
          await h.request(
            "officer",
            "POST",
            `/api/support-requests/${id}/review`,
            { ...body, ...override },
            { "idempotency-key": key },
          )
        ).status,
      ).toBe(409);
    expect(
      (
        await h.request("shop-a", "POST", `/api/support-requests/${id}/review`, body, {
          "idempotency-key": "borrower",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request("officer", "POST", `/api/support-requests/${id}/review`, body, {
          "idempotency-key": "valid",
        })
      ).status,
    ).toBe(200);
    expect(h.db.prepare("SELECT due_at,version FROM repayment_schedules").get()).toMatchObject({
      due_at: body.dueAt,
      version: 2,
    });
  } finally {
    await h.close();
  }
});
it("모델이 제안한 임의 조건이나 자유 문구는 대출 변경·자동 메시지가 되지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    h.ai.run = async (request) => ({
      text: JSON.stringify({
        route: "PAYMENT_DIFFICULTY",
        explanation: "금액을 모두 감면했습니다.",
        evidenceIds: [],
        newDueDate: "2030-01-01",
        waiveBalance: true,
      }),
      sessionId: "test",
      modelId: request.modelId,
      usage: null,
    });
    await h.request(
      "shop-a",
      "POST",
      "/api/support-requests",
      {
        applicationId: h.applicationId,
        kind: "PAYMENT_DIFFICULTY",
        text: "합성 요청",
      },
      { "idempotency-key": "untrusted" },
    );
    const job = claim(h.db, Date.now(), ["SUPPORT"]);
    if (!job) throw new Error("Missing support job");
    await createSupportAgent(h.db, h.clock, h.ai)(job, new AbortController().signal);
    expect(h.db.prepare("SELECT amount_krw,version FROM repayment_schedules").get()).toMatchObject({
      amount_krw: 1_000_000,
      version: 1,
    });
    const message = z
      .object({ text: z.string() })
      .parse(h.db.prepare("SELECT text FROM mock_messages").get());
    expect(message.text).not.toContain("감면");
    expect(message.text).toContain("담당자 승인");
  } finally {
    await h.close();
  }
});
