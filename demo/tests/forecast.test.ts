import { expect, it } from "vitest";
import { forecast, type ScheduledFlow } from "../src/domain/forecast.js";

const flows: ScheduledFlow[] = [
  { id: "pg", day: 3, amountKrw: 5_000_000, certainty: "CONFIRMED" },
  { id: "payroll", day: 5, amountKrw: -6_000_000, certainty: "CONFIRMED" },
  { id: "repayment", day: 10, amountKrw: -1_000_000, certainty: "CONFIRMED" },
];
it("7일과 30일의 최저 잔액을 구분한다", () => {
  expect(forecast(3_000_000, flows, 7).minimumKrw).toBe(2_000_000);
  expect(forecast(3_000_000, flows, 30).minimumKrw).toBe(1_000_000);
});
it("D+8 정산이면 D+5~7에 300만 원이 부족하다", () => {
  const delayed = flows.map((row) => (row.id === "pg" ? { ...row, day: 8 } : row));
  const result = forecast(3_000_000, delayed, 30);
  expect(result.minimumKrw).toBe(-3_000_000);
  expect(result.shortageDays).toEqual([5, 6, 7]);
});
it("같은 날의 미확인 일중 순서를 안전하다고 단정하지 않는다", () => {
  const result = forecast(
    100,
    [
      { id: "in", day: 1, amountKrw: 200, certainty: "CONFIRMED" },
      { id: "out", day: 1, amountKrw: -200, certainty: "CONFIRMED" },
    ],
    7,
  );
  expect(result.closingKrw).toBe(100);
  expect(result.uncertainties).toContain("INTRADAY_ORDER_UNKNOWN");
});
it("지급 여부가 불명확한 정산은 기본 전망에서 제외한다", () => {
  const result = forecast(
    3_000_000,
    flows.map((row) => (row.id === "pg" ? { ...row, certainty: "UNKNOWN" } : row)),
    30,
  );
  expect(result.closingKrw).toBe(-4_000_000);
  expect(result.uncertainties).toContain("UNCONFIRMED_FLOW");
  expect(result.uncertainties).toContain("FUTURE_FLOWS_INCOMPLETE");
});
it.each([NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "잘못된 원 단위 금액 %s를 거부한다",
  (value) => {
    expect(() => forecast(value, [], 7)).toThrow("INVALID_MONEY");
  },
);
it("합계가 안전 정수 범위를 넘으면 실패한다", () => {
  expect(() =>
    forecast(
      Number.MAX_SAFE_INTEGER,
      [{ id: "over", day: 1, amountKrw: 1, certainty: "CONFIRMED" }],
      7,
    ),
  ).toThrow("INVALID_MONEY");
});
it("동일 schedule ID를 중복 반영하지 않는다", () => {
  expect(() => forecast(3_000_000, [...flows, flows[2]!], 30)).toThrow("DUPLICATE_FLOW");
});
