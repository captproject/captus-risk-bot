import express, { Request, Response, NextFunction } from "express";
import { chromium, Browser, BrowserContext, Page, Locator } from "playwright";

// ─── Types ───────────────────────────────────────────────────────────────────

interface RiskInput {
  username: string;
  password: string;
  title: string;
  description: string;
  category: string;
  status: string;
  impact: string;
  likelihood: string;
  owner: string;
  dueDate: string;
  potentialCost: string;
  mitigationPlan: string;
}

interface EditRiskInput {
  username: string;
  password: string;
  searchTitle: string;
  newTitle?: string;
  newDescription?: string;
  newCategory?: string;
  newStatus?: string;
  newImpact?: string;
  newLikelihood?: string;
  newOwner?: string;
  newDueDate?: string;
  newPotentialCost?: string;
  newMitigationPlan?: string;
}

interface DeleteRiskInput {
  username: string;
  password: string;
  searchTitle: string;
}

interface StatusWorkflowInput {
  username: string;
  password: string;
  title: string;
  description: string;
  category: string;
  impact: string;
  likelihood: string;
  owner: string;
  dueDate: string;
  potentialCost: string;
  mitigationPlan: string;
}

interface FilterRiskInput {
  username: string;
  password: string;
  statusFilter?: string;
  categoryFilter?: string;
}

interface ToastResult {
  detected: boolean;
  actualText: string | null;
  expectedText: string;
  match: boolean;
}

interface StepResult {
  step: string;
  status: "pass" | "fail";
  expected_status: string;
  actual_status: string | null;
  version: number | null;
}

interface RiskResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
  riskTitle: string;
  assertion: { expected: string; actual: string | null; match: boolean };
  screenshots: { failure?: string | null; table_issue?: string | null };
}

interface StatusWorkflowResult {
  status: "pass" | "fail" | "error";
  message: string;
  riskTitle: string;
  assertion: { expected: string; actual: string; match: boolean };
  steps: StepResult[];
  versions_created: number;
  screenshots: { final_status: string | null; failure: string | null };
}

interface FilterRowData {
  title: string;
  category: string | null;
  status: string | null;
}

interface FilterRiskResult {
  status: "pass" | "fail" | "error";
  filters: { status: string; category: string };
  assertion: { expected: string; actual: string; match: boolean };
  total_rows: number;
  mismatched_rows: FilterRowData[];
  screenshots: { failure: string | null };
}

interface Config {
  loginUrl: string;
  dashboardUrl: string;
  tableUrl: string;
  apiKey: string;
  supabaseUrl: string;
  supabaseKey: string;
  port: number;
  navigationTimeout: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const config: Config = {
  loginUrl: process.env.LOGIN_URL || "https://captus.replit.app/login",
  dashboardUrl:
    process.env.DASHBOARD_URL || "https://captus.replit.app/dashboard",
  tableUrl: process.env.TABLE_URL || "https://captus.replit.app/table",
  apiKey: process.env.API_KEY || "",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_KEY || "",
  port: Number(process.env.PORT) || 3000,
  navigationTimeout: 60_000,
};

const KNOWN_STATUSES = ["Open", "In Review", "Mitigated", "Closed"] as const;
const KNOWN_CATEGORIES = [
  "Budget",
  "Schedule",
  "Safety",
  "Quality",
  "Environmental",
  "Legal",
  "Technical",
  "Resource",
  "Other",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ─── Browser Pool ────────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) return browserInstance;
  browserInstance = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
    ],
  });
  return browserInstance;
}

async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

// ─── Screenshot Upload ───────────────────────────────────────────────────────

async function uploadScreenshot(
  buffer: Buffer,
  label: string,
): Promise<string | null> {
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `risk_${label}_${timestamp}.png`;
  try {
    const response = await fetch(
      `${config.supabaseUrl}/storage/v1/object/screenshots/${fileName}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.supabaseKey}`,
          "Content-Type": "image/png",
          "x-upsert": "true",
        },
        body: buffer,
      },
    );
    if (response.ok) {
      return `${config.supabaseUrl}/storage/v1/object/public/screenshots/${fileName}`;
    }
    console.error(`Screenshot upload failed: ${await response.text()}`);
    return null;
  } catch (err) {
    console.error(
      `Screenshot upload error: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── Helper: Capture failure screenshot safely ───────────────────────────────

async function captureFailure(
  context: BrowserContext | null,
  label: string,
): Promise<string | null> {
  if (!context) return null;
  try {
    const pages = context.pages();
    if (pages.length > 0) {
      const buf = await pages[0].screenshot({ fullPage: true });
      return await uploadScreenshot(buf, label);
    }
  } catch {
    // screenshot capture itself failed — swallow
  }
  return null;
}

// ─── Helper: Safe context cleanup ────────────────────────────────────────────

async function safeClose(context: BrowserContext | null): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
  }
}

// ─── Helper: Select Dropdown ─────────────────────────────────────────────────
// Uses Playwright locators with a single evaluate fallback.

async function selectDropdown(
  page: Page,
  triggerTestId: string,
  optionText: string,
): Promise<boolean> {
  try {
    const trigger = page.getByTestId(triggerTestId);
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    await trigger.click();

    const option = page.getByRole("option", { name: optionText });
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click();
    // Wait for the listbox to close, confirming selection took effect
    await page
      .getByRole("listbox")
      .waitFor({ state: "hidden", timeout: 3_000 })
      .catch(() => {});
    return true;
  } catch {
    console.log(
      `[Dropdown] Locator failed for "${triggerTestId}" → "${optionText}", using evaluate fallback`,
    );
  }

  // Fallback: direct DOM manipulation
  const clicked = await page.evaluate((testId) => {
    const btn = document.querySelector(
      `[data-testid="${testId}"]`,
    ) as HTMLButtonElement | null;
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, triggerTestId);
  if (!clicked) return false;

  // Wait for options to render
  await page
    .getByRole("option")
    .first()
    .waitFor({ state: "visible", timeout: 3_000 })
    .catch(() => {});

  const selected = await page.evaluate((text) => {
    const options = document.querySelectorAll('[role="option"]');
    for (const opt of options) {
      if (opt.textContent?.trim().includes(text)) {
        (opt as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, optionText);
  return selected;
}

// ─── Helper: Set Due Date ────────────────────────────────────────────────────
// Navigates the react-day-picker calendar using locators instead of raw evaluate.

async function setDueDate(page: Page, dateString: string): Promise<void> {
  const [yearStr, monthStr, dayStr] = dateString.split("-");
  const targetYear = parseInt(yearStr);
  const targetMonth = parseInt(monthStr);
  const targetDay = parseInt(dayStr).toString();
  const targetMonthYear = `${MONTH_NAMES[targetMonth - 1]} ${targetYear}`;

  console.log(
    `[DueDate] Target: ${targetMonthYear}, day ${targetDay}`,
  );

  const dateButton = page.getByTestId("button-risk-due-date");
  await dateButton.waitFor({ state: "visible", timeout: 10_000 });
  await dateButton.click();

  // Wait for the calendar to appear
  await page
    .locator('[role="grid"]')
    .first()
    .waitFor({ state: "visible", timeout: 5_000 });

  // Navigate months until we reach the target
  for (let i = 0; i < 24; i++) {
    const headingText = await page
      .locator('[class*="rdp"], [id^="react-day-picker"]')
      .first()
      .textContent()
      .catch(() => "");

    if (headingText?.includes(targetMonthYear)) {
      console.log("[DueDate] Correct month found");
      break;
    }

    // Try standard next-month button selectors in priority order
    const nextBtn =
      page.locator('button[name="next-month"]').or(
        page.locator('button[aria-label="Go to next month"]'),
      ).or(
        page.locator('button[aria-label="Go to the next month"]'),
      ).or(
        page.locator(".rdp-nav button:last-child"),
      );

    const nextVisible = await nextBtn
      .first()
      .isVisible()
      .catch(() => false);
    if (nextVisible) {
      await nextBtn.first().click();
    } else {
      console.log("[DueDate] Could not find next-month button");
      break;
    }

    // Wait for calendar to re-render after month change
    await page.waitForTimeout(300);
  }

  // Click the target day inside a gridcell
  console.log(`[DueDate] Clicking day: ${targetDay}`);
  const dayButton = page
    .locator('[role="gridcell"] button')
    .filter({ hasText: new RegExp(`^${targetDay}$`) })
    .and(page.locator(":not([disabled])"));

  const dayCount = await dayButton.count();
  if (dayCount > 0) {
    await dayButton.first().click();
  } else {
    // Fallback: click gridcell text directly
    await page.evaluate((day) => {
      const cells = document.querySelectorAll('[role="gridcell"]');
      for (const cell of cells) {
        const button = cell.querySelector("button");
        const textEl = button || cell;
        if (
          textEl.textContent?.trim() === day &&
          !button?.hasAttribute("disabled") &&
          cell.getAttribute("aria-disabled") !== "true"
        ) {
          (button || (cell as HTMLElement)).click();
          return;
        }
      }
    }, targetDay);
  }

  // Wait for calendar to close
  await page
    .locator('[role="grid"]')
    .first()
    .waitFor({ state: "hidden", timeout: 3_000 })
    .catch(() => {});

  console.log("[DueDate] Due date set");
}

// ─── Helper: Search for Risk ─────────────────────────────────────────────────
// Uses Playwright's fill() which properly triggers React's synthetic events.

async function searchRisk(page: Page, title: string): Promise<void> {
  console.log(`[Search] Searching for: "${title}"`);
  const searchInput = page.getByTestId("input-search-risks");
  await searchInput.waitFor({ state: "visible", timeout: 10_000 });
  await searchInput.fill(title);
  // Wait for the table to react to the search filter
  await page.waitForTimeout(1_500);
  console.log("[Search] Done");
}

// ─── Helper: Detect Toast ────────────────────────────────────────────────────
// Uses a Playwright locator race instead of a polling evaluate loop.

async function detectToast(
  page: Page,
  expectedText: string,
): Promise<ToastResult> {
  console.log(`[Toast] Watching for: "${expectedText}"`);
  const result: ToastResult = {
    detected: false,
    actualText: null,
    expectedText,
    match: false,
  };

  // Build a composite locator covering common toast implementations
  const toastLocator = page
    .locator('[data-sonner-toast]')
    .or(page.locator('[role="status"]'))
    .or(page.locator('[data-radix-toast-viewport] > *'))
    .or(page.locator('[class*="Toastify"]'));

  try {
    await toastLocator
      .first()
      .waitFor({ state: "visible", timeout: 6_000 });

    const toastText = await toastLocator.first().textContent();
    if (toastText?.trim()) {
      result.detected = true;
      result.actualText = toastText.trim();
      result.match = result.actualText
        .toLowerCase()
        .includes(expectedText.toLowerCase());
    }
  } catch {
    // Toast didn't appear within timeout — fall back to DOM scan
    const fallbackText = await page.evaluate(() => {
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        const t = el.textContent?.trim() || "";
        if (
          el.children.length <= 2 &&
          t.toLowerCase().includes("successfully") &&
          t.length < 100
        ) {
          return t;
        }
      }
      return null;
    });
    if (fallbackText) {
      result.detected = true;
      result.actualText = fallbackText;
      result.match = fallbackText
        .toLowerCase()
        .includes(expectedText.toLowerCase());
    }
  }

  console.log(
    `[Toast] Detected: ${result.detected} | Actual: "${result.actualText}" | Match: ${result.match}`,
  );
  return result;
}

// ─── Helper: Fill Risk Form ──────────────────────────────────────────────────
// Uses Playwright's native fill() which handles React controlled inputs correctly.

async function fillRiskForm(
  page: Page,
  data: {
    title?: string;
    description?: string;
    category?: string;
    status?: string;
    impact?: string;
    likelihood?: string;
    owner?: string;
    dueDate?: string;
    potentialCost?: string;
    mitigationPlan?: string;
  },
): Promise<void> {
  if (data.title) {
    console.log(`[Form] Title: "${data.title}"`);
    const field = page.getByTestId("input-risk-title");
    await field.waitFor({ state: "visible", timeout: 5_000 });
    await field.clear();
    await field.fill(data.title);
  }

  if (data.description) {
    console.log("[Form] Description");
    const field = page.getByTestId("input-risk-description");
    await field.waitFor({ state: "visible", timeout: 5_000 });
    await field.clear();
    await field.fill(data.description);
  }

  if (data.category) {
    console.log(`[Form] Category: "${data.category}"`);
    await selectDropdown(page, "select-risk-category", data.category);
  }

  if (data.status) {
    console.log(`[Form] Status: "${data.status}"`);
    await selectDropdown(page, "select-risk-status", data.status);
  }

  if (data.impact) {
    console.log(`[Form] Impact: "${data.impact}"`);
    await selectDropdown(page, "select-risk-impact", data.impact);
  }

  if (data.likelihood) {
    console.log(`[Form] Likelihood: "${data.likelihood}"`);
    await selectDropdown(page, "select-risk-likelihood", data.likelihood);
  }

  if (data.owner) {
    console.log(`[Form] Owner: "${data.owner}"`);
    const field = page.getByTestId("input-risk-owner");
    await field.waitFor({ state: "visible", timeout: 5_000 });
    await field.clear();
    await field.fill(data.owner);
  }

  if (data.dueDate) {
    console.log(`[Form] Due date: "${data.dueDate}"`);
    await setDueDate(page, data.dueDate);
  }

  if (data.potentialCost) {
    console.log(`[Form] Cost: "${data.potentialCost}"`);
    const field = page.getByTestId("input-risk-potential-cost");
    await field.waitFor({ state: "visible", timeout: 5_000 });
    await field.clear();
    await field.fill(data.potentialCost);
  }

  if (data.mitigationPlan) {
    console.log("[Form] Mitigation plan");
    const field = page.getByTestId("input-risk-mitigation");
    await field.waitFor({ state: "visible", timeout: 5_000 });
    await field.clear();
    await field.fill(data.mitigationPlan);
  }
}

// ─── Core Login ──────────────────────────────────────────────────────────────
// Uses Playwright fill() + click() instead of evaluate-based prototype hacking.

async function performLogin(
  page: Page,
  username: string,
  password: string,
): Promise<boolean> {
  try {
    await page.goto(config.loginUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });

    const emailInput = page.locator('input[name="email"]');
    await emailInput.waitFor({ state: "visible", timeout: 15_000 });
    await emailInput.fill(username);

    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.waitFor({ state: "visible", timeout: 5_000 });
    await passwordInput.fill(password);

    const loginBtn = page.getByTestId("button-login");
    await loginBtn.waitFor({ state: "visible", timeout: 5_000 });
    await loginBtn.click();

    // Wait for navigation away from /login (up to 15s)
    await page
      .waitForURL((url) => !url.pathname.includes("/login"), {
        timeout: 15_000,
      })
      .catch(() => {});

    const loggedIn = !page.url().includes("/login");
    console.log(
      `[Login] ${loggedIn ? "Success" : "Failed"} — URL: ${page.url()}`,
    );
    return loggedIn;
  } catch (err) {
    console.error(`[Login] Error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Helper: Navigate and wait for page to settle ────────────────────────────

async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: "networkidle",
    timeout: config.navigationTimeout,
  });
  // Give the SPA a moment to hydrate after network settles
  await page.waitForTimeout(2_000);
}

// ─── Helper: Click an edit button for the first search result ────────────────

async function clickFirstEditButton(page: Page): Promise<boolean> {
  const editBtn = page
    .locator('[data-testid^="button-edit-heatmap-risk-"]')
    .first();
  try {
    await editBtn.waitFor({ state: "visible", timeout: 5_000 });
    await editBtn.click();
    // Wait for the form/dialog to appear
    await page
      .getByTestId("input-risk-title")
      .waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    console.log("[Edit] Edit button not found or form didn't open");
    return false;
  }
}

// ─── Helper: Assert risk presence in body ────────────────────────────────────

async function riskVisibleInPage(
  page: Page,
  title: string,
): Promise<boolean> {
  try {
    await page
      .locator("body")
      .filter({ hasText: title })
      .waitFor({ state: "visible", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

// ─── CREATE RISK ─────────────────────────────────────────────────────────────

async function performCreateRisk(input: RiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error",
    message: "",
    username: input.username,
    riskTitle: input.title,
    assertion: { expected: "Risk created successfully", actual: null, match: false },
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    // Login
    console.log(`[Create] Logging in as ${input.username}`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "failed";
      result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "create_login_failed");
      return result;
    }

    // Navigate to dashboard
    await navigateTo(page, config.dashboardUrl);

    // Open the "Add Risk" dialog
    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addBtn.click();
    // Wait for form to appear
    await page
      .getByTestId("input-risk-title")
      .waitFor({ state: "visible", timeout: 5_000 });

    // Fill form
    await fillRiskForm(page, {
      title: input.title,
      description: input.description,
      category: input.category,
      status: input.status,
      impact: input.impact,
      likelihood: input.likelihood,
      owner: input.owner,
      dueDate: input.dueDate,
      potentialCost: input.potentialCost,
      mitigationPlan: input.mitigationPlan,
    });

    // Save
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();

    // Assert: toast OR risk visible in page
    const toast = await detectToast(page, "Risk created successfully");
    result.assertion.actual = toast.actualText;
    result.assertion.match = toast.match;

    if (!toast.detected) {
      // Fallback: check that the risk title appears on the page
      const visible = await riskVisibleInPage(page, input.title);
      if (visible) {
        result.assertion.actual = "Toast missed — risk found in page";
        result.assertion.match = true;
      }
    }

    if (!result.assertion.match) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "create_failed");
      result.status = "failed";
      result.message = "Risk creation could not be confirmed";
      return result;
    }

    result.status = "success";
    result.message = result.assertion.actual || "Risk created";
    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "create_error");
    result.status = "error";
    result.message = (error as Error).message;
    return result;
  } finally {
    await safeClose(context);
  }
}

// ─── EDIT RISK ───────────────────────────────────────────────────────────────

async function performEditRisk(input: EditRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error",
    message: "",
    username: input.username,
    riskTitle: input.searchTitle,
    assertion: { expected: "Risk updated successfully", actual: null, match: false },
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    // Login
    console.log(`[Edit] Logging in as ${input.username}`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "failed";
      result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "edit_login_failed");
      return result;
    }

    await navigateTo(page, config.dashboardUrl);

    // Search and open edit form
    await searchRisk(page, input.searchTitle);

    if (!(await clickFirstEditButton(page))) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "edit_btn_not_found");
      result.status = "failed";
      result.message = `Edit button not found for: "${input.searchTitle}"`;
      return result;
    }

    // Fill updated fields
    await fillRiskForm(page, {
      title: input.newTitle,
      description: input.newDescription,
      category: input.newCategory,
      status: input.newStatus,
      impact: input.newImpact,
      likelihood: input.newLikelihood,
      owner: input.newOwner,
      dueDate: input.newDueDate,
      potentialCost: input.newPotentialCost,
      mitigationPlan: input.newMitigationPlan,
    });

    // Save
    const updateBtn = page.getByTestId("button-save-risk");
    await updateBtn.waitFor({ state: "visible", timeout: 5_000 });
    await updateBtn.click();

    // Assert
    const toast = await detectToast(page, "Risk updated successfully");
    result.assertion.actual = toast.actualText;
    result.assertion.match = toast.match;

    if (!toast.detected && input.newTitle) {
      const visible = await riskVisibleInPage(page, input.newTitle);
      if (visible) {
        result.assertion.actual = "Toast missed — updated risk found in page";
        result.assertion.match = true;
      }
    }

    if (!result.assertion.match) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "edit_failed");
      result.status = "failed";
      result.message = "Risk update could not be confirmed";
      return result;
    }

    result.status = "success";
    result.message = result.assertion.actual || "Risk updated";
    result.riskTitle = input.newTitle || input.searchTitle;
    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "edit_error");
    result.status = "error";
    result.message = (error as Error).message;
    return result;
  } finally {
    await safeClose(context);
  }
}

// ─── DELETE RISK ─────────────────────────────────────────────────────────────

async function performDeleteRisk(input: DeleteRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error",
    message: "",
    username: input.username,
    riskTitle: input.searchTitle,
    assertion: { expected: "Risk deleted successfully", actual: null, match: false },
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    // Login
    console.log(`[Delete] Logging in as ${input.username}`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "failed";
      result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_login_failed");
      return result;
    }

    await navigateTo(page, config.tableUrl);

    // Search for the risk
    await searchRisk(page, input.searchTitle);

    // Click the risk row to expand it — use a text locator
    const riskRow = page.locator("text=" + input.searchTitle).first();
    try {
      await riskRow.waitFor({ state: "visible", timeout: 5_000 });
      await riskRow.click();
    } catch {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_not_found");
      result.status = "failed";
      result.message = `Risk not found in table: "${input.searchTitle}"`;
      return result;
    }

    // Wait for expanded content then click delete
    await page.waitForTimeout(1_500);

    const deleteBtn = page
      .locator('[data-testid^="button-delete-risk-"]')
      .first();
    try {
      await deleteBtn.waitFor({ state: "visible", timeout: 5_000 });
      await deleteBtn.click();
    } catch {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_btn_not_found");
      result.status = "failed";
      result.message = "Delete button not found after expanding risk row";
      return result;
    }

    // Assert: toast OR risk gone from page
    const toast = await detectToast(page, "Risk deleted successfully");
    result.assertion.actual = toast.actualText;
    result.assertion.match = toast.match;

    if (!toast.detected) {
      // Re-search and verify risk is gone
      await searchRisk(page, input.searchTitle);
      const stillExists = await riskVisibleInPage(page, input.searchTitle);
      if (!stillExists) {
        result.assertion.actual = "Toast missed — risk confirmed removed";
        result.assertion.match = true;
      }
    }

    if (!result.assertion.match) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "delete_failed");
      result.status = "failed";
      result.message = "Risk deletion could not be confirmed";
      return result;
    }

    result.status = "success";
    result.message = result.assertion.actual || "Risk deleted";
    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "delete_error");
    result.status = "error";
    result.message = (error as Error).message;
    return result;
  } finally {
    await safeClose(context);
  }
}

// ─── RISK STATUS WORKFLOW ────────────────────────────────────────────────────

async function verifyRiskStatus(
  page: Page,
  title: string,
  expectedStatus: string,
): Promise<{ actual: string | null; versionCount: number }> {
  await navigateTo(page, config.tableUrl);
  await searchRisk(page, title);

  // Find the status badge using known status values
  const statusBadge = page
    .locator("div.inline-flex")
    .filter({ hasText: new RegExp(`^(${KNOWN_STATUSES.join("|")})$`) })
    .first();

  let actual: string | null = null;
  try {
    await statusBadge.waitFor({ state: "visible", timeout: 5_000 });
    actual = (await statusBadge.textContent())?.trim() || null;
  } catch {
    console.log("[Status] Could not find status badge");
  }

  console.log(`[Status] Badge found: "${actual}" (expected: "${expectedStatus}")`);

  // Click the risk row to check version history
  const riskRow = page.locator("text=" + title).first();
  await riskRow.click().catch(() => {});
  await page.waitForTimeout(1_500);

  const versionCount = await page.evaluate(() => {
    const allText = document.body.innerText;
    const match = allText.match(/Version History\s*\((\d+)\)/i);
    if (match) return parseInt(match[1]);
    return document.querySelectorAll('[data-testid^="version-entry-"]').length;
  });
  console.log(`[Status] Version count: ${versionCount}`);

  return { actual, versionCount };
}

async function updateRiskStatus(
  page: Page,
  title: string,
  newStatus: string,
): Promise<{ success: boolean; toastText: string | null }> {
  await navigateTo(page, config.dashboardUrl);
  await searchRisk(page, title);

  if (!(await clickFirstEditButton(page))) {
    console.log("[Status] Edit button not found");
    return { success: false, toastText: null };
  }

  const dropdownSelected = await selectDropdown(
    page,
    "select-risk-status",
    newStatus,
  );
  if (!dropdownSelected) {
    console.log(`[Status] Failed to select status: "${newStatus}"`);
    return { success: false, toastText: null };
  }

  const updateBtn = page.getByTestId("button-save-risk");
  await updateBtn.waitFor({ state: "visible", timeout: 5_000 });
  await updateBtn.click();

  const toast = await detectToast(page, "Risk updated successfully");
  return { success: toast.detected, toastText: toast.actualText };
}

async function performStatusWorkflow(
  input: StatusWorkflowInput,
): Promise<StatusWorkflowResult> {
  let context: BrowserContext | null = null;
  const statusSequence = ["Open", "In Review", "Mitigated", "Closed"];
  const steps: StepResult[] = [];
  const actualSequence: string[] = [];

  const result: StatusWorkflowResult = {
    status: "error",
    message: "",
    riskTitle: input.title,
    assertion: {
      expected: statusSequence.join(" -> "),
      actual: "",
      match: false,
    },
    steps: [],
    versions_created: 0,
    screenshots: { final_status: null, failure: null },
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    // Login
    console.log(`[Workflow] Logging in as ${input.username}`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "fail";
      result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "status_login_failed");
      return result;
    }

    // Create the risk
    await navigateTo(page, config.dashboardUrl);

    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10_000 });
    await addBtn.click();
    await page
      .getByTestId("input-risk-title")
      .waitFor({ state: "visible", timeout: 5_000 });

    await fillRiskForm(page, {
      title: input.title,
      description: input.description,
      category: input.category,
      status: "Open",
      impact: input.impact,
      likelihood: input.likelihood,
      owner: input.owner,
      dueDate: input.dueDate,
      potentialCost: input.potentialCost,
      mitigationPlan: input.mitigationPlan,
    });

    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 });
    await saveBtn.click();

    const createToast = await detectToast(page, "Risk created successfully");
    if (!createToast.detected) {
      // Fallback check
      const visible = await riskVisibleInPage(page, input.title);
      if (!visible) {
        result.status = "fail";
        result.message = "Risk creation failed";
        const s = await page.screenshot({ fullPage: true });
        result.screenshots.failure = await uploadScreenshot(s, "status_create_failed");
        result.steps = steps;
        return result;
      }
    }

    // Step 1: Verify initial status "Open"
    console.log("[Workflow] Step 1: Verify Open");
    const openCheck = await verifyRiskStatus(page, input.title, "Open");
    steps.push({
      step: "create",
      status: openCheck.actual === "Open" ? "pass" : "fail",
      expected_status: "Open",
      actual_status: openCheck.actual,
      version: openCheck.versionCount,
    });
    if (openCheck.actual === "Open") {
      actualSequence.push("Open");
      console.log("[Workflow] OK: Open");
    } else {
      console.log(`[Workflow] FAIL: Expected Open, got "${openCheck.actual}"`);
    }

    // Steps 2-4: Transition through In Review -> Mitigated -> Closed
    const transitions = [
      { step: "update_in_review", target: "In Review" },
      { step: "update_mitigated", target: "Mitigated" },
      { step: "update_closed", target: "Closed" },
    ];

    for (const { step, target } of transitions) {
      console.log(`[Workflow] Transitioning to: "${target}"`);

      const updateResult = await updateRiskStatus(page, input.title, target);
      if (!updateResult.success) {
        steps.push({
          step,
          status: "fail",
          expected_status: target,
          actual_status: null,
          version: null,
        });
        const s = await page.screenshot({ fullPage: true });
        result.screenshots.failure = await uploadScreenshot(
          s,
          `status_${target.toLowerCase().replace(" ", "_")}_failed`,
        );
        continue;
      }

      const check = await verifyRiskStatus(page, input.title, target);
      steps.push({
        step,
        status: check.actual === target ? "pass" : "fail",
        expected_status: target,
        actual_status: check.actual,
        version: check.versionCount,
      });

      if (check.actual === target) {
        actualSequence.push(target);
        console.log(
          `[Workflow] OK: ${target} (toast: "${updateResult.toastText}")`,
        );
      } else {
        console.log(
          `[Workflow] FAIL: Expected "${target}", got "${check.actual}"`,
        );
      }

      // Capture version count from the last step
      if (step === "update_closed") {
        result.versions_created = check.versionCount;
      }
    }

    // Final screenshot
    const finalShot = await page.screenshot({ fullPage: true });
    result.screenshots.final_status = await uploadScreenshot(
      finalShot,
      "status_final",
    );

    // Build result
    result.steps = steps;
    result.assertion.actual = actualSequence.join(" -> ");
    result.assertion.match =
      result.assertion.expected === result.assertion.actual;
    const allPassed = steps.every((s) => s.status === "pass");
    result.status = allPassed ? "pass" : "fail";
    result.message = allPassed
      ? "All status transitions completed successfully"
      : `Some transitions failed. Actual: ${result.assertion.actual}`;

    console.log(`[Workflow] Expected: ${result.assertion.expected}`);
    console.log(`[Workflow] Actual:   ${result.assertion.actual}`);
    console.log(`[Workflow] Match:    ${result.assertion.match}`);

    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "status_error");
    result.status = "error";
    result.message = (error as Error).message;
    result.steps = steps;
    return result;
  } finally {
    await safeClose(context);
  }
}

// ─── FILTER RISKS ────────────────────────────────────────────────────────────

async function extractTableRows(page: Page): Promise<FilterRowData[]> {
  console.log("[Filter] Extracting table rows");

  const rows: FilterRowData[] = await page.evaluate(
    ({ statuses, categories }) => {
      const results: FilterRowData[] = [];
      const allBadges = document.querySelectorAll("div.inline-flex");
      const processedRows = new Set<Element>();

      for (const badge of allBadges) {
        let rowEl: HTMLElement | null = badge.parentElement;
        while (
          rowEl &&
          rowEl.tagName !== "TR" &&
          !rowEl.className?.includes("border-b") &&
          !rowEl.className?.includes("row")
        ) {
          rowEl = rowEl.parentElement;
        }
        if (!rowEl || processedRows.has(rowEl)) continue;

        const rowBadges = rowEl.querySelectorAll("div.inline-flex");
        let rowStatus: string | null = null;
        let rowCategory: string | null = null;
        let rowTitle = "";

        for (const rb of rowBadges) {
          const rbText = rb.textContent?.trim() || "";
          if (statuses.includes(rbText)) rowStatus = rbText;
          if (categories.includes(rbText)) rowCategory = rbText;
        }

        if (rowStatus || rowCategory) {
          const textEls = rowEl.querySelectorAll("*");
          for (const el of textEls) {
            const elText = el.textContent?.trim() || "";
            if (
              el.children.length === 0 &&
              elText.length > 3 &&
              elText.length < 300 &&
              !statuses.includes(elText) &&
              !categories.includes(elText) &&
              !/^\d+$/.test(elText) &&
              !elText.startsWith("$") &&
              elText !== "\u2014" &&
              !elText.includes("Risk")
            ) {
              rowTitle = elText;
              break;
            }
          }
          processedRows.add(rowEl);
          results.push({ title: rowTitle, category: rowCategory, status: rowStatus });
        }
      }
      return results;
    },
    {
      statuses: [...KNOWN_STATUSES],
      categories: [...KNOWN_CATEGORIES],
    },
  );

  console.log(`[Filter] Extracted ${rows.length} rows`);
  for (const row of rows) {
    console.log(
      `[Filter]   "${row.title}" | Category: ${row.category} | Status: ${row.status}`,
    );
  }
  return rows;
}

async function performFilterRisks(
  input: FilterRiskInput,
): Promise<FilterRiskResult> {
  let context: BrowserContext | null = null;
  const statusFilter = input.statusFilter || "All Status";
  const categoryFilter = input.categoryFilter || "All";
  const result: FilterRiskResult = {
    status: "error",
    filters: { status: statusFilter, category: categoryFilter },
    assertion: { expected: "All rows match filters", actual: "", match: false },
    total_rows: 0,
    mismatched_rows: [],
    screenshots: { failure: null },
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    // Login
    console.log(`[Filter] Logging in as ${input.username}`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "fail";
      result.assertion.actual = "Login failed";
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "filter_login_failed");
      return result;
    }

    await navigateTo(page, config.tableUrl);

    // Apply filters
    if (statusFilter !== "All Status") {
      console.log(`[Filter] Status filter: "${statusFilter}"`);
      await selectDropdown(page, "select-status-filter", statusFilter);
      await page.waitForTimeout(1_500);
    }
    if (categoryFilter !== "All") {
      console.log(`[Filter] Category filter: "${categoryFilter}"`);
      await selectDropdown(page, "select-category-filter", categoryFilter);
      await page.waitForTimeout(1_500);
    }

    // Wait for table to settle
    await page.waitForTimeout(1_000);

    // Extract and validate rows
    const rows = await extractTableRows(page);

    if (rows.length === 0) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "filter_no_rows");
      result.status = "fail";
      result.total_rows = 0;
      result.assertion.actual = "No rows found after applying filters";
      return result;
    }

    const mismatched: FilterRowData[] = [];
    for (const row of rows) {
      const statusOk =
        statusFilter === "All Status" || row.status === statusFilter;
      const categoryOk =
        categoryFilter === "All" || row.category === categoryFilter;
      if (!statusOk || !categoryOk) {
        mismatched.push(row);
        console.log(
          `[Filter] MISMATCH: "${row.title}" status=${row.status} category=${row.category}`,
        );
      }
    }

    result.total_rows = rows.length;
    result.mismatched_rows = mismatched;

    if (mismatched.length === 0) {
      result.status = "pass";
      result.assertion.actual = `All ${rows.length} rows matched filters`;
      result.assertion.match = true;
      console.log(`[Filter] PASS: all ${rows.length} rows match`);
    } else {
      result.status = "fail";
      result.assertion.actual = `${mismatched.length} of ${rows.length} rows did not match`;
      result.assertion.match = false;
      console.log(`[Filter] FAIL: ${mismatched.length} mismatched`);
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "filter_mismatch");
    }

    // Clear filters
    if (statusFilter !== "All Status") {
      await selectDropdown(page, "select-status-filter", "All Status");
    }
    if (categoryFilter !== "All") {
      await selectDropdown(page, "select-category-filter", "All");
    }

    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "filter_error");
    result.status = "error";
    result.assertion.actual = (error as Error).message;
    return result;
  } finally {
    await safeClose(context);
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!config.apiKey) {
    next();
    return;
  }
  if (req.headers["x-api-key"] !== config.apiKey) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }
  next();
}

app.post("/create-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<RiskInput>;
  if (!input.username || !input.password || !input.title) {
    res.status(400).json({ status: "error", message: "Missing: username, password, title" });
    return;
  }
  const full: RiskInput = {
    username: input.username,
    password: input.password,
    title: input.title,
    description: input.description || "",
    category: input.category || "Technical",
    status: input.status || "Open",
    impact: input.impact || "3 - Medium",
    likelihood: input.likelihood || "3 - Medium",
    owner: input.owner || "",
    dueDate: input.dueDate || "",
    potentialCost: input.potentialCost || "",
    mitigationPlan: input.mitigationPlan || "",
  };
  const result = await performCreateRisk(full);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/edit-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<EditRiskInput>;
  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" });
    return;
  }
  const result = await performEditRisk(input as EditRiskInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/delete-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<DeleteRiskInput>;
  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" });
    return;
  }
  const result = await performDeleteRisk(input as DeleteRiskInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/risk-status-workflow", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<StatusWorkflowInput>;
  if (!input.username || !input.password || !input.title) {
    res.status(400).json({ status: "error", message: "Missing: username, password, title" });
    return;
  }
  const full: StatusWorkflowInput = {
    username: input.username,
    password: input.password,
    title: input.title,
    description: input.description || "Status workflow test risk",
    category: input.category || "Technical",
    impact: input.impact || "3 - Medium",
    likelihood: input.likelihood || "3 - Medium",
    owner: input.owner || "",
    dueDate: input.dueDate || "",
    potentialCost: input.potentialCost || "",
    mitigationPlan: input.mitigationPlan || "",
  };
  const result = await performStatusWorkflow(full);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/filter-risks", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<FilterRiskInput>;
  if (!input.username || !input.password) {
    res.status(400).json({ status: "error", message: "Missing: username, password" });
    return;
  }
  const result = await performFilterRisks(input as FilterRiskInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "running",
    service: "captus-risk-bot",
    endpoints: [
      "/create-risk",
      "/edit-risk",
      "/delete-risk",
      "/risk-status-workflow",
      "/filter-risks",
    ],
    browserConnected: browserInstance?.isConnected() ?? false,
    timestamp: new Date().toISOString(),
  });
});

// ─── Start & Shutdown ────────────────────────────────────────────────────────

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Risk Bot running on port ${config.port}`);
  console.log(`Dashboard: ${config.dashboardUrl}`);
  console.log(`Table:     ${config.tableUrl}`);
  console.log(`Screenshots: ${config.supabaseUrl ? "ENABLED" : "DISABLED"}`);
  console.log(`Auth:        ${config.apiKey ? "ENABLED" : "DISABLED"}`);
});

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
