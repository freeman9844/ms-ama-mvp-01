import { expect, test } from "@playwright/test";
import { login } from "./helpers.js";

test("보완 수집의 조회기간 변경은 별도 동의를 받아 재개한다", async ({ page }) => {
  await page.goto("/");
  await login(page, "shop-a");
  await page.getByRole("link", { name: "대출 신청", exact: true }).click();
  await page.getByLabel("사업자명", { exact: true }).fill("보완 갱신 검증");
  await page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" }).check();
  await page.getByRole("button", { name: "최종 제출" }).click();
  await expect(page.getByText("담당자 검토 대기", { exact: true })).toBeVisible();
  await login(page, "officer");
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "보완 갱신 검증 · 담당자 검토 대기" }) })
    .getByRole("button", { name: "심사 상세 열기" })
    .click();
  await page.getByRole("button", { name: "보완 요청", exact: true }).click();
  await login(page, "operator");
  await page.getByLabel("사건 유형").selectOption("ADVANCE_TIME");
  await page.getByLabel("이동 일수").fill("1");
  await page.getByRole("button", { name: "사건 실행" }).click();
  await expect(page.getByRole("status")).toContainText("APPLIED");
  await login(page, "shop-a");
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "보완 갱신 검증 · 10,000,000원" }) });
  const consent = card.getByRole("checkbox", { name: "보완 심사 자료 제공 동의 갱신" });
  await expect(consent).not.toBeChecked();
  await consent.check();
  await card.getByRole("button", { name: "합성 보완자료 제출" }).click();
  await expect(card.getByText("담당자 검토 대기", { exact: true })).toBeVisible();
});

test("동의는 사전 선택되지 않고 수집 결과 승인 단계가 없다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "합성 사업자 A로 시작" }).click();
  await page.getByRole("link", { name: "대출 신청", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" }),
  ).not.toBeChecked();
  await expect(page.getByRole("button", { name: "최종 제출" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" }).check();
  await page.getByRole("button", { name: "최종 제출" }).click();
  await expect(page.getByRole("heading", { name: "내 신청 현황" })).toBeVisible();
  await expect(page.getByText("담당자 검토 대기", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "수집 결과 승인" })).toHaveCount(0);
});
test("모바일 폭에서 키보드로 동의를 조작하며 다른 사업자 신청은 보이지 않는다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "합성 사업자 B로 시작" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("아직 신청이 없습니다.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "대출 신청", exact: true }).focus();
  await page.keyboard.press("Enter");
  const checkbox = page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test("두 담당자 화면에서 중복 승인하면 오래된 화면은 409 안내를 표시한다", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "합성 사업자 A로 시작" }).click();
  await page.getByRole("link", { name: "대출 신청", exact: true }).click();
  await page.getByLabel("사업자명", { exact: true }).fill("합성 UI 검토");
  await page.getByRole("checkbox", { name: "신청 심사 데이터 제공 동의" }).check();
  await page.getByRole("button", { name: "최종 제출" }).click();
  await expect(page.getByText("담당자 검토 대기", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "로그아웃·계정 변경" }).click();
  await page.getByRole("button", { name: "담당자로 시작" }).click();
  const target = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "합성 UI 검토 · 담당자 검토 대기" }) });
  await target.getByRole("button", { name: "심사 상세 열기" }).click();
  await expect(page.getByRole("button", { name: "모의 대출 승인" })).toBeEnabled();
  const other = await context.newPage();
  await other.goto("/");
  await other
    .locator("article")
    .filter({ has: other.getByRole("heading", { name: "합성 UI 검토 · 담당자 검토 대기" }) })
    .getByRole("button", { name: "심사 상세 열기" })
    .click();
  await expect(other.getByRole("button", { name: "모의 대출 승인" })).toBeEnabled();
  await page.getByRole("button", { name: "모의 대출 승인" }).click();
  await expect(page.getByRole("heading", { name: "합성 UI 검토 · 승인 완료" })).toBeVisible();
  await other.getByRole("button", { name: "모의 대출 승인" }).click();
  await expect(other.getByRole("alert")).toContainText("STALE_REVIEW");
  await other.close();
});
test("별도 모니터링 동의는 기본 해제이며 철회 후 삭제 완료를 표시한다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "합성 사업자 A로 시작" }).click();
  await page.getByRole("link", { name: "데이터 동의", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "사후 모니터링 데이터 제공 동의" }),
  ).not.toBeChecked();
  const first = page.locator("article").first();
  await first.getByRole("button", { name: "이 동의 철회" }).click();
  await first.getByRole("button", { name: "철회 및 삭제 요청 확인" }).click();
  await expect(first).toContainText("접근: BLOCKED · 삭제: 완료");
});
test("사건 후 메타데이터 새로고침은 폼 선택과 완료 안내를 지우지 않는다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "운영자로 시작" }).click();
  await page.getByLabel("사건 유형").selectOption("ADVANCE_TIME");
  await page.getByLabel("이동 일수").fill("1");
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/demo/state"));
  await page.getByRole("button", { name: "사건 실행" }).click();
  await refreshed;
  await expect(page.getByLabel("사건 유형")).toHaveValue("ADVANCE_TIME");
  await expect(page.getByRole("status")).toContainText("APPLIED");
});
test("실패한 작업은 신청 상태가 분석 중이어도 자동 조회를 중단한다", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/applications", async (route) => {
    reads++;
    await route.fulfill({
      json: [
        {
          id: "failed-application",
          status: "ANALYZING",
          companyName: "실패 시나리오",
          requestedAmountKrw: 1000000,
          consentIds: [],
          evidenceDeleted: false,
        },
      ],
    });
  });
  await page.route("**/api/timeline", (route) =>
    route.fulfill({
      json: [
        {
          id: "failed-job",
          applicationId: "failed-application",
          kind: "UNDERWRITE",
          status: "FAILED",
          errorCode: "AI_UNAVAILABLE",
          modelId: "test",
          toolCount: 0,
          inputTokens: null,
          outputTokens: null,
        },
      ],
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "합성 사업자 A로 시작" }).click();
  await expect(page.getByRole("button", { name: "작업 재시도" })).toBeVisible();
  await page.waitForTimeout(6500);
  expect(reads).toBeLessThanOrEqual(2);
});
