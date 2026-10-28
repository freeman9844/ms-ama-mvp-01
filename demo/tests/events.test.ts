import { expect, it } from "vitest";
import { createReviewFixture } from "./helpers/review.js";
import { z } from "zod";
import { consentInput } from "./helpers/consent.js";

it("원천 장애 사건은 지정한 요청 수만 실패시키고 자동 미납을 만들지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    const event = {
      id: "fault-bank",
      businessId: "shop-a",
      type: "SOURCE_FAILURE",
      source: "BANK",
      requests: 2,
    };
    expect((await h.request("operator", "POST", "/api/demo/events", event)).status).toBe(200);
    const query = { ...consentInput, businessId: "shop-a", consentId: h.consentIds[0] };
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const response = await h.sourceRequest("BANK", query, null);
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(statuses).toEqual([503, 503, 200]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='MONITOR'").get()).toMatchObject(
      { n: 0 },
    );
  } finally {
    await h.close();
  }
});

it("정산 지급 사건을 반복해도 은행 입금은 한 번만 반영한다", async () => {
  const h = await createReviewFixture();
  try {
    const event = {
      id: "paid-1",
      businessId: "shop-a",
      type: "SETTLEMENT_PAID",
      settlementId: "shop-a-settlement",
    };
    expect((await h.request("operator", "POST", "/api/demo/events", event)).status).toBe(200);
    expect((await h.request("operator", "POST", "/api/demo/events", event)).status).toBe(200);
    const rows = h.sourceDb.prepare("SELECT payload FROM source_records WHERE kind='BANK'").all();
    expect(
      rows.filter((row) => {
        const payload = z.object({ payload: z.string() }).parse(row).payload;
        return JSON.parse(payload).settlementId === "shop-a-settlement";
      }),
    ).toHaveLength(1);
  } finally {
    await h.close();
  }
});
it("시간 이동 자체는 미납이 아니며 미래 일정의 미납을 거부한다", async () => {
  const h = await createReviewFixture();
  try {
    await h.runAssessment();
    await h.review();
    const missed = {
      id: "miss-1",
      businessId: "shop-a",
      type: "MISSED_PAYMENT",
      scheduleId: `${h.applicationId}-loan`,
    };
    expect((await h.request("operator", "POST", "/api/demo/events", missed)).status).toBe(409);
    expect(
      (
        await h.request("operator", "POST", "/api/demo/events", {
          id: "advance-1",
          businessId: "shop-a",
          type: "ADVANCE_TIME",
          days: 10,
        })
      ).status,
    ).toBe(200);
    expect(h.db.prepare("SELECT status FROM repayment_schedules").get()).toMatchObject({
      status: "SCHEDULED",
    });
    expect((await h.request("operator", "POST", "/api/demo/events", missed)).status).toBe(200);
    expect(h.db.prepare("SELECT status FROM repayment_schedules").get()).toMatchObject({
      status: "MISSED",
    });
  } finally {
    await h.close();
  }
});
it("원천 사건의 오래된 재전송은 업무 시계를 되돌리지 않는다", async () => {
  const h = await createReviewFixture();
  try {
    const first = { id: "time-1", businessId: "shop-a", type: "ADVANCE_TIME", days: 1 };
    expect((await h.request("operator", "POST", "/api/demo/events", first)).status).toBe(200);
    expect(
      (await h.request("operator", "POST", "/api/demo/events", { ...first, id: "time-2" })).status,
    ).toBe(200);
    const before = h.clock.now().toISOString();
    const { payload } = z
      .object({ payload: z.string() })
      .parse(h.sourceDb.prepare("SELECT payload FROM source_events WHERE id='time-1'").get());
    const replay = await fetch(`${h.mockUrl}/internal/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.serviceToken}`, "content-type": "application/json" },
      body: payload,
    });
    expect(replay.status).toBe(200);
    expect(h.clock.now().toISOString()).toBe(before);
  } finally {
    await h.close();
  }
});
it("원천만 지급 완료한 뒤 재시작해도 PENDING 사건을 중복 입금 없이 복구한다", async () => {
  const h = await createReviewFixture();
  try {
    const event = {
      id: "recover-paid",
      businessId: "shop-a",
      type: "SETTLEMENT_PAID",
      settlementId: "shop-a-settlement",
    };
    const payload = JSON.stringify({
      event,
      generation: 1,
      occurredAt: h.clock.now().toISOString(),
      nextTime: new Date(h.clock.now().getTime() + 1).toISOString(),
    });
    h.db.prepare("INSERT INTO demo_events VALUES (?,?,'PENDING',NULL)").run(event.id, payload);
    const applied = await fetch(`${h.mockUrl}/internal/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.serviceToken}`, "content-type": "application/json" },
      body: payload,
    });
    expect(applied.status).toBe(200);
    expect((await h.request("operator", "POST", "/api/demo/events", event)).status).toBe(200);
    expect(
      h.sourceDb
        .prepare("SELECT COUNT(*) AS n FROM source_records WHERE id='recover-paid-bank'")
        .get(),
    ).toMatchObject({ n: 1 });
    expect(h.db.prepare("SELECT state FROM demo_events WHERE id=?").get(event.id)).toMatchObject({
      state: "APPLIED",
    });
  } finally {
    await h.close();
  }
});
