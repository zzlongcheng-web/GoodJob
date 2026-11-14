import { expect, test } from "@playwright/test";

test("Golden Gain branding, authenticated team management, and staff privacy", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Golden Gain/);
  await page.locator("#loginEmail").fill("alex@goodjob.com");
  await page.locator("#loginPassword").fill("goodjob123");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await expect(page.locator("#scopeUser")).toContainText("Alex");
  await expect(page.locator("#topSearchInput")).toHaveAttribute("placeholder", "搜索模块，回车直达");

  const manager = await page.evaluate(async () => {
    const response = await fetch("/api/reports/executive?managementMonth=2026-11", { credentials: "same-origin" });
    return { status: response.status, payload: await response.json() };
  });
  expect(manager.status).toBe(200);
  expect(manager.payload.management?.target).toBe(61);
  expect(Array.isArray(manager.payload.management?.rows)).toBe(true);

  await page.locator("#logoutButton").click();
  await expect(page.locator("body")).not.toHaveClass(/is-authenticated/);
  await page.locator("#loginEmail").fill("shirley@goodjob.com");
  await page.locator("#loginPassword").fill("goodjob123");
  await page.locator("#loginButton").click();
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  const salesperson = await page.evaluate(async () => {
    const response = await fetch("/api/reports/executive?managementMonth=2026-11", { credentials: "same-origin" });
    return { status: response.status, payload: await response.json() };
  });
  expect(salesperson.status).toBe(200);
  expect(salesperson.payload.management).toBeNull();
});
