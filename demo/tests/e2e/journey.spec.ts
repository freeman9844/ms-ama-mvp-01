import { test } from "@playwright/test";
import {
  resetFromUi,
  revokeFromUi,
  runApprovedLoanJourney,
  runWarningAndSupport,
} from "./helpers.js";

test("신청·심사·경보·미납 지원·철회·초기화의 전체 여정", async ({ page }) => {
  await page.goto("/");
  await resetFromUi(page);
  await runApprovedLoanJourney(page);
  await runWarningAndSupport(page);
  await revokeFromUi(page);
  await resetFromUi(page);
});
