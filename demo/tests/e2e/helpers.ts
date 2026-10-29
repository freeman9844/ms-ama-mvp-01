import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { timelineView } from "../../src/domain/views.js";

export async function login(page: Page, role: "shop-a" | "officer" | "operator") {
  if (await page.getByRole("button", { name: "로그아웃·계정 변경" }).isVisible())
    await page.getByRole("button", { name: "로그아웃·계정 변경" }).click();
  const names = {
    "shop-a": "합성 사업자 A로 시작",
    officer: "담당자로 시작",
    operator: "운영자로 시작",
  };
  await page.getByRole("button", { name: names[role] }).click();
  await expect(page.getByRole("button", { name: "로그아웃·계정 변경" })).toBeVisible();
}
export async function waitForJob(page: Page, kind: string) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(new URL("/api/timeline", page.url()).toString());
    expect(response.ok()).toBe(true);
    const jobs = z.array(timelineView).parse(await response.json());
    const job = jobs.find((row) => row.kind === kind);
    if (job?.status === "COMPLETED") return job;
    if (job && ["FAILED", "CANCELLED", "BLOCKED_BY_CONSENT"].includes(job.status))
      throw new Error(`${kind}: ${job.status} ${job.errorCode}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`JOB_TIMEOUT: ${kind}`);
}
export async function resetFromUi(page: Page) {
  await login(page, "operator");
  await page.getByRole("button", { name: "초기화 준비" }).click();
  await page.getByRole("button", { name: "초기화 확인", exact: true }).click();
  await expect(page.getByRole("button", { name: "합성 사업자 A로 시작" })).toBeVisible();
}
export async function runApprovedLoanJourney(page: Page) {
  await login(page, "shop-a");
  await page.getByRole("link", { name: "대출 신청", exact: true }).click();
  await page.getByLabel("사업자명", { exact: true }).fill("전체 여정 합성 가게");
  await page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" }).check();
  await page.getByRole("button", { name: "최종 제출" }).click();
  await expect(page.getByRole("heading", { name: "내 신청 현황" })).toBeVisible();
  await waitForJob(page, "UNDERWRITE");
  await login(page, "officer");
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "전체 여정 합성 가게 · 담당자 검토 대기" }) })
    .getByRole("button", { name: "심사 상세 열기" })
    .click();
  await page.getByRole("button", { name: "모의 대출 승인" }).click();
  await expect(
    page.getByRole("heading", { name: "전체 여정 합성 가게 · 승인 완료" }),
  ).toBeVisible();
  await login(page, "shop-a");
  await page.getByRole("link", { name: "데이터 동의", exact: true }).click();
  await page.getByRole("checkbox", { name: "사후 모니터링 데이터 제공 동의" }).check();
  await page.getByRole("button", { name: "모니터링 동의 등록·갱신" }).click();
  await expect(page.getByRole("heading", { name: "BANK · 사후 모니터링" })).toBeVisible();
}
export async function triggerDemoEvent(
  page: Page,
  type: "SETTLEMENT_DELAY" | "ADVANCE_TIME" | "MISSED_PAYMENT",
) {
  await login(page, "operator");
  await page.getByLabel("사건 유형").selectOption(type);
  if (type === "MISSED_PAYMENT") {
    const select = page.getByLabel("대상 상환 일정");
    await expect(select.locator("option")).toHaveCount(2);
    await select.selectOption({ index: 1 });
  }
  await page.getByRole("button", { name: "사건 실행" }).click();
  await expect(page.getByRole("status")).toContainText("APPLIED");
}
export async function runWarningAndSupport(page: Page) {
  await triggerDemoEvent(page, "SETTLEMENT_DELAY");
  await waitForJob(page, "MONITOR");
  await login(page, "officer");
  await expect(page.getByText("코드 계산 최저 잔액: -3,000,000원")).toBeVisible();
  await expect(page.getByRole("heading", { name: "상환 지원 검토" })).toBeVisible();
  const requests = await page.request.get(new URL("/api/support-requests", page.url()).toString());
  expect(await requests.json()).toEqual([]);
  await triggerDemoEvent(page, "ADVANCE_TIME");
  await triggerDemoEvent(page, "MISSED_PAYMENT");
  await waitForJob(page, "SUPPORT");
  await login(page, "officer");
  await expect(
    page.getByText("합성 미납 사건입니다. 고객 보호 정책에 따라 검토하세요."),
  ).toBeVisible();
}
export async function revokeFromUi(page: Page) {
  await login(page, "shop-a");
  await page.getByRole("link", { name: "데이터 동의", exact: true }).click();
  const row = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "BANK · 신청 심사" }) });
  await row.getByRole("button", { name: "이 동의 철회" }).click();
  await row.getByRole("button", { name: "철회 및 삭제 요청 확인" }).click();
  await expect(row).toContainText("접근: BLOCKED · 삭제: 완료");
}
