import express, { Request, Response, NextFunction } from "express";
import { chromium, Browser, BrowserContext, Page } from "playwright";

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
  assertion: {
    expected: string;
    actual: string | null;
    match: boolean;
  };
  screenshots: {
    failure?: string | null;
    table_issue?: string | null;
  };
}

interface StatusWorkflowResult {
  status: "pass" | "fail" | "error";
  message: string;
  riskTitle: string;
  assertion: {
    expected: string;
    actual: string;
    match: boolean;
  };
  steps: StepResult[];
  versions_created: number;
  screenshots: {
    final_status: string | null;
    failure: string | null;
  };
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
  dashboardUrl: process.env.DASHBOARD_URL || "https://captus.replit.app/dashboard",
  tableUrl: process.env.TABLE_URL || "https://captus.replit.app/table",
  apiKey: process.env.API_KEY || "",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_KEY || "",
  port: Number(process.env.PORT) || 3000,
  navigationTimeout: 60_000,
};

// ─── Browser Pool ────────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) {
    return browserInstance;
  }
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

async function uploadScreenshot(buffer: Buffer, label: string): Promise<string | null> {
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
      }
    );

    if (response.ok) {
      return `${config.supabaseUrl}/storage/v1/object/public/screenshots/${fileName}`;
    }

    const errText = await response.text();
    console.error(`Screenshot upload failed: ${errText}`);
    return null;
  } catch (err) {
    console.error(`Screenshot upload error: ${(err as Error).message}`);
    return null;
  }
}

// ─── Helper: Fill Text Input (React Native Setter) ──────────────────────────

async function fillInput(page: Page, testId: string, value: string): Promise<void> {
  await page.evaluate(
    ({ testId, val }) => {
      const input = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLTextAreaElement;
      if (input) {
        const proto = input.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;

        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(input, val);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { testId, val: value }
  );
}

// ─── Helper: Select Dropdown Option (Radix UI) ──────────────────────────────

async function selectDropdown(page: Page, triggerTestId: string, optionText: string): Promise<boolean> {
  try {
    // Try built-in locator first
    const trigger = page.getByTestId(triggerTestId);
    await trigger.waitFor({ state: "visible", timeout: 10000 });
    await trigger.click();
    await page.waitForTimeout(500);

    const option = page.getByRole("option", { name: optionText });
    await option.waitFor({ state: "visible", timeout: 5000 });
    await option.click();
    await page.waitForTimeout(300);
    return true;
  } catch {
    console.log(`[Risk] Built-in locator failed for dropdown — falling back to evaluate`);

    // Fallback: use page.evaluate
    const clicked = await page.evaluate(
      ({ testId, text }) => {
        const trigger = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
        if (trigger) trigger.click();
        return !!trigger;
      },
      { testId: triggerTestId, text: optionText }
    );

    if (!clicked) return false;

    await page.waitForTimeout(500);

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

    await page.waitForTimeout(300);
    return selected;
  }
}

// ─── Helper: Set Due Date ────────────────────────────────────────────────────

async function setDueDate(page: Page, dateString: string): Promise<void> {
  const dateButton = page.getByTestId("button-risk-due-date");
  await dateButton.waitFor({ state: "visible", timeout: 10000 });
  await dateButton.click();
  await page.waitForTimeout(1000);

  const parts = dateString.split("-");
  const targetYear = parseInt(parts[0]);
  const targetMonth = parseInt(parts[1]);
  const targetDay = parseInt(parts[2]).toString();

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const targetMonthName = monthNames[targetMonth - 1];
  const targetMonthYear = `${targetMonthName} ${targetYear}`;

  console.log(`[Risk] Looking for calendar month: ${targetMonthYear}, day: ${targetDay}`);

  for (let i = 0; i < 12; i++) {
    const headingText = await page.evaluate(() => {
      const rdp = document.querySelector('[id^="react-day-picker"]');
      if (rdp && rdp.textContent?.trim()) return rdp.textContent.trim();
      const presentations = document.querySelectorAll('[role="presentation"]');
      for (const el of presentations) {
        const text = el.textContent?.trim() || "";
        if (/[A-Z][a-z]+ \d{4}/.test(text)) return text;
      }
      return "";
    });

    console.log(`[Risk] Current calendar month: ${headingText}`);
    if (headingText.includes(targetMonthYear)) {
      console.log("[Risk] Correct month found");
      break;
    }

    const clicked = await page.evaluate(() => {
      const selectors = [
        'button[name="next-month"]',
        'button[aria-label="Go to next month"]',
        'button.rdp-button_next',
        'button.rdp-nav_button_next',
        '.rdp-nav button:last-child',
        'button[aria-label="Go to the next month"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel) as HTMLButtonElement;
        if (btn) { btn.click(); return true; }
      }
      const allButtons = document.querySelectorAll('button');
      for (const btn of allButtons) {
        const label = btn.getAttribute('aria-label') || '';
        if (label.toLowerCase().includes('next')) { btn.click(); return true; }
      }
      return false;
    });

    if (!clicked) { console.log("[Risk] Could not find next month button"); break; }
    await page.waitForTimeout(500);
  }

  console.log(`[Risk] Clicking day: ${targetDay}`);
  await page.evaluate((day) => {
    const cells = document.querySelectorAll('[role="gridcell"]');
    for (const cell of cells) {
      const button = cell.querySelector("button");
      const textEl = button || cell;
      if (textEl.textContent?.trim() === day) {
        const isDisabled = button?.hasAttribute("disabled") ||
          cell.classList.toString().includes("outside") ||
          cell.getAttribute("aria-disabled") === "true";
        if (!isDisabled) { (button || cell as HTMLElement).click(); return; }
      }
    }
  }, targetDay);

  await page.waitForTimeout(500);
  console.log("[Risk] Due date set");
}

// ─── Helper: Search for Risk by Title ────────────────────────────────────────

async function searchRisk(page: Page, title: string): Promise<void> {
  console.log(`[Risk] Searching for: ${title}`);
  await page.evaluate(
    (searchText) => {
      const input = document.querySelector('[data-testid="input-search-risks"]') as HTMLInputElement;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, searchText);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    title
  );
  await page.waitForTimeout(2000);
  console.log("[Risk] Search completed");
}

// ─── Helper: Detect Toast Message (Captures Actual UI Text) ──────────────────

async function detectToast(page: Page, expectedText: string): Promise<ToastResult> {
  console.log(`[Risk] Watching for toast: "${expectedText}"...`);

  const result: ToastResult = {
    detected: false,
    actualText: null,
    expectedText: expectedText,
    match: false,
  };

  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);

    const toastText = await page.evaluate(() => {
      const toastSelectors = [
        '[data-sonner-toast] [data-content]',
        '[data-sonner-toast]',
        '[role="status"]',
        '[data-radix-toast-viewport] > *',
        '.toast-message',
        '[class*="toast"] [class*="title"]',
        '[class*="toast"] [class*="description"]',
        '[class*="Toastify"]',
      ];
      for (const sel of toastSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent?.trim()) return el.textContent.trim();
      }
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent?.trim() || "";
        const isSmall = el.children.length === 0 || el.children.length <= 2;
        if (isSmall && text.toLowerCase().includes("successfully") && text.length < 100) return text;
      }
      return null;
    });

    if (toastText) {
      result.detected = true;
      result.actualText = toastText;
      result.match = toastText.toLowerCase().includes(expectedText.toLowerCase());
      console.log(`[Risk] Toast captured after ${(i + 1) * 500}ms`);
      console.log(`[Risk] Expected: "${expectedText}"`);
      console.log(`[Risk] Actual:   "${toastText}"`);
      console.log(`[Risk] Match:    ${result.match}`);
      return result;
    }
  }

  console.log("[Risk] Toast not detected within 5 seconds");
  return result;
}

// ─── Helper: Fill Risk Form (Shared by Create and Edit) ─────────────────────

async function fillRiskForm(page: Page, data: {
  title?: string; description?: string; category?: string;
  status?: string; impact?: string; likelihood?: string;
  owner?: string; dueDate?: string; potentialCost?: string;
  mitigationPlan?: string;
}): Promise<void> {

  if (data.title) {
    console.log(`[Risk] Filling title: ${data.title}`);
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-title"]') as HTMLInputElement;
      if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; if (s) s.call(input, ''); input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await fillInput(page, "input-risk-title", data.title);
    await page.waitForTimeout(300);
  }

  if (data.description) {
    console.log("[Risk] Filling description");
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-description"]') as HTMLTextAreaElement;
      if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set; if (s) s.call(input, ''); input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await fillInput(page, "input-risk-description", data.description);
    await page.waitForTimeout(300);
  }

  if (data.category) {
    console.log(`[Risk] Selecting category: ${data.category}`);
    await selectDropdown(page, "select-risk-category", data.category);
  }

  if (data.status) {
    console.log(`[Risk] Selecting status: ${data.status}`);
    await selectDropdown(page, "select-risk-status", data.status);
  }

  if (data.impact) {
    console.log(`[Risk] Selecting impact: ${data.impact}`);
    await selectDropdown(page, "select-risk-impact", data.impact);
  }

  if (data.likelihood) {
    console.log(`[Risk] Selecting likelihood: ${data.likelihood}`);
    await selectDropdown(page, "select-risk-likelihood", data.likelihood);
  }

  if (data.owner) {
    console.log(`[Risk] Filling owner: ${data.owner}`);
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-owner"]') as HTMLInputElement;
      if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; if (s) s.call(input, ''); input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await fillInput(page, "input-risk-owner", data.owner);
    await page.waitForTimeout(300);
  }

  if (data.dueDate) {
    console.log(`[Risk] Setting due date: ${data.dueDate}`);
    await setDueDate(page, data.dueDate);
  }

  if (data.potentialCost) {
    console.log(`[Risk] Filling potential cost: ${data.potentialCost}`);
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-potential-cost"]') as HTMLInputElement;
      if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; if (s) s.call(input, ''); input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await fillInput(page, "input-risk-potential-cost", data.potentialCost);
    await page.waitForTimeout(300);
  }

  if (data.mitigationPlan) {
    console.log("[Risk] Filling mitigation plan");
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-mitigation"]') as HTMLTextAreaElement;
      if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set; if (s) s.call(input, ''); input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await fillInput(page, "input-risk-mitigation", data.mitigationPlan);
    await page.waitForTimeout(300);
  }
}

// ─── Core Login Logic ────────────────────────────────────────────────────────

async function performLogin(page: Page, username: string, password: string): Promise<boolean> {
  try {
    await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForSelector('input[name="email"]', { state: "visible", timeout: 15000 });
    await page.waitForTimeout(5000);

    await page.evaluate((email) => {
      const input = document.querySelector('input[name="email"]') as HTMLInputElement;
      if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; if (s) s.call(input, email); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }
    }, username);

    await page.evaluate((pass) => {
      const input = document.querySelector('input[name="password"]') as HTMLInputElement;
      if (input) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; if (s) s.call(input, pass); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }
    }, password);

    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="button-login"]') as HTMLButtonElement;
      if (btn) btn.click();
    });

    await page.waitForTimeout(5000);
    return !page.url().includes("/login");
  } catch (err) {
    console.error(`Login error: ${(err as Error).message}`);
    return false;
  }
}

// ─── CREATE RISK ─────────────────────────────────────────────────────────────

async function performCreateRisk(input: RiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: input.title,
    assertion: { expected: "Risk created successfully", actual: null, match: false },
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    console.log(`[Create] Logging in as ${input.username}...`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "failed"; result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "create_login_failed");
      await context.close(); return result;
    }
    console.log("[Create] Login successful");

    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(3000);

    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10000 }); await addBtn.click();
    await page.waitForTimeout(2000);

    await fillRiskForm(page, { title: input.title, description: input.description, category: input.category, status: input.status, impact: input.impact, likelihood: input.likelihood, owner: input.owner, dueDate: input.dueDate, potentialCost: input.potentialCost, mitigationPlan: input.mitigationPlan });

    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5000 }); await saveBtn.click();

    const toast = await detectToast(page, "Risk created successfully");
    result.assertion.actual = toast.actualText; result.assertion.match = toast.match;
    let success = toast.detected;

    if (!success) {
      await page.waitForTimeout(2000);
      success = await page.evaluate((t) => document.body.innerText.includes(t), input.title);
      if (success) { result.assertion.actual = "Toast missed — risk found in table"; result.assertion.match = true; }
    }

    if (!success) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "create_failed");
      result.status = "failed"; result.message = "Risk creation failed"; await context.close(); return result;
    }

    result.status = "success"; result.message = toast.actualText || "Risk created — confirmed in table";
    await context.close(); return result;
  } catch (error) {
    if (context) { try { const p = context.pages(); if (p.length > 0) { const s = await p[0].screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "create_error"); } } catch {} await context.close().catch(() => {}); }
    result.status = "error"; result.message = (error as Error).message; return result;
  }
}

// ─── EDIT RISK ───────────────────────────────────────────────────────────────

async function performEditRisk(input: EditRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: input.searchTitle,
    assertion: { expected: "Risk updated successfully", actual: null, match: false },
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    console.log(`[Edit] Logging in as ${input.username}...`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "failed"; result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "edit_login_failed");
      await context.close(); return result;
    }
    console.log("[Edit] Login successful");

    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(3000);
    await searchRisk(page, input.searchTitle);

    console.log("[Edit] Looking for edit button...");
    const editClicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('[data-testid^="button-edit-heatmap-risk-"]');
      if (btns.length >= 1) { (btns[0] as HTMLButtonElement).click(); return true; }
      return false;
    });

    if (!editClicked) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "edit_btn_not_found");
      result.status = "failed"; result.message = `Edit button not found for: ${input.searchTitle}`; await context.close(); return result;
    }

    await page.waitForTimeout(2000);
    await fillRiskForm(page, { title: input.newTitle, description: input.newDescription, category: input.newCategory, status: input.newStatus, impact: input.newImpact, likelihood: input.newLikelihood, owner: input.newOwner, dueDate: input.newDueDate, potentialCost: input.newPotentialCost, mitigationPlan: input.newMitigationPlan });

    const updateBtn = page.getByTestId("button-save-risk");
    await updateBtn.waitFor({ state: "visible", timeout: 5000 }); await updateBtn.click();

    const toast = await detectToast(page, "Risk updated successfully");
    result.assertion.actual = toast.actualText; result.assertion.match = toast.match;
    let success = toast.detected;

    if (!success && input.newTitle) {
      await page.waitForTimeout(2000);
      success = await page.evaluate((t) => document.body.innerText.includes(t), input.newTitle);
      if (success) { result.assertion.actual = "Toast missed — updated risk found in table"; result.assertion.match = true; }
    }

    if (!success) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "edit_failed");
      result.status = "failed"; result.message = "Risk update failed"; await context.close(); return result;
    }

    result.status = "success"; result.message = toast.actualText || "Risk updated — confirmed in table";
    result.riskTitle = input.newTitle || input.searchTitle;
    await context.close(); return result;
  } catch (error) {
    if (context) { try { const p = context.pages(); if (p.length > 0) { const s = await p[0].screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "edit_error"); } } catch {} await context.close().catch(() => {}); }
    result.status = "error"; result.message = (error as Error).message; return result;
  }
}

// ─── DELETE RISK ─────────────────────────────────────────────────────────────

async function performDeleteRisk(input: DeleteRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: input.searchTitle,
    assertion: { expected: "Risk deleted successfully", actual: null, match: false },
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    console.log(`[Delete] Logging in as ${input.username}...`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "failed"; result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_login_failed");
      await context.close(); return result;
    }
    console.log("[Delete] Login successful");

    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(3000);
    await searchRisk(page, input.searchTitle);

    console.log("[Delete] Expanding risk row...");
    const expanded = await page.evaluate((title) => {
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if (el.textContent?.trim() === title && el.children.length === 0) { (el as HTMLElement).click(); return true; }
      }
      for (const el of allElements) {
        if (el.textContent?.includes(title) && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          if ((el as HTMLElement).offsetHeight < 100) { (el as HTMLElement).click(); return true; }
        }
      }
      return false;
    }, input.searchTitle);

    if (!expanded) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_not_found");
      result.status = "failed"; result.message = `Risk not found: ${input.searchTitle}`; await context.close(); return result;
    }

    await page.waitForTimeout(2000);

    console.log("[Delete] Clicking Delete button...");
    const deleteClicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('[data-testid^="button-delete-risk-"]');
      if (btns.length > 0) { (btns[0] as HTMLButtonElement).click(); return true; }
      return false;
    });

    if (!deleteClicked) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_btn_not_found");
      result.status = "failed"; result.message = "Delete button not found"; await context.close(); return result;
    }

    const toast = await detectToast(page, "Risk deleted successfully");
    result.assertion.actual = toast.actualText; result.assertion.match = toast.match;
    let success = toast.detected;

    if (!success) {
      await page.waitForTimeout(2000);
      await searchRisk(page, input.searchTitle);
      const stillExists = await page.evaluate((t) => document.body.innerText.includes(t), input.searchTitle);
      if (!stillExists) { success = true; result.assertion.actual = "Toast missed — risk confirmed removed"; result.assertion.match = true; }
    }

    if (!success) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_failed");
      result.status = "failed"; result.message = "Risk deletion failed"; await context.close(); return result;
    }

    result.status = "success"; result.message = toast.actualText || "Risk deleted — confirmed removed";
    await context.close(); return result;
  } catch (error) {
    if (context) { try { const p = context.pages(); if (p.length > 0) { const s = await p[0].screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_error"); } } catch {} await context.close().catch(() => {}); }
    result.status = "error"; result.message = (error as Error).message; return result;
  }
}

// ─── RISK STATUS WORKFLOW ────────────────────────────────────────────────────

async function verifyRiskStatus(page: Page, title: string, expectedStatus: string): Promise<{ actual: string | null; versionCount: number }> {
  await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(3000);
  await searchRisk(page, title);

  // Wait for search results to settle
  await page.waitForTimeout(2000);

  // Get status by finding any visible status badge text on the page
  // Since we searched for a specific risk, the visible status badge belongs to our risk
  const actual = await page.evaluate((statuses) => {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const text = el.textContent?.trim() || "";
      // Match exact status text in small elements (badges)
      if (statuses.includes(text) && el.children.length === 0) {
        // Verify it's a badge-like element (small, styled)
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width > 0 && rect.width < 200 && rect.height > 0 && rect.height < 50) {
          return text;
        }
      }
    }
    return null;
  }, ["Open", "In Review", "Mitigated", "Closed"]);

  console.log(`[Status] Status badge found: ${actual}`);

  // Click to expand and get version count
  await page.evaluate((riskTitle) => {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.textContent?.trim() === riskTitle && el.children.length === 0) {
        (el as HTMLElement).click();
        return;
      }
    }
  }, title);

  await page.waitForTimeout(2000);

  // Get version count
  const versionCount = await page.evaluate(() => {
    // Try heading text first
    const allText = document.body.innerText;
    const match = allText.match(/Version History\s*\((\d+)\)/i);
    if (match) return parseInt(match[1]);

    // Fallback: count version entries
    const entries = document.querySelectorAll('[data-testid^="version-entry-"]');
    return entries.length;
  });

  console.log(`[Status] Version count: ${versionCount}`);

  return { actual, versionCount };
}

async function updateRiskStatus(page: Page, title: string, newStatus: string): Promise<{ success: boolean; toastText: string | null }> {
  await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(3000);
  await searchRisk(page, title);

  // Wait for search results to settle
  await page.waitForTimeout(1000);

  const editClicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('[data-testid^="button-edit-heatmap-risk-"]');
    if (btns.length >= 1) { (btns[0] as HTMLButtonElement).click(); return true; }
    return false;
  });

  if (!editClicked) { console.log("[Status] Edit button not found"); return { success: false, toastText: null }; }
  
  // Wait for edit modal to fully open
  await page.waitForTimeout(3000);

  const dropdownSelected = await selectDropdown(page, "select-risk-status", newStatus);
  if (!dropdownSelected) { 
    console.log(`[Status] Failed to select status: ${newStatus}`);
    return { success: false, toastText: null }; 
  }

  // Wait after dropdown selection
  await page.waitForTimeout(500);

  const updateBtn = page.getByTestId("button-save-risk");
  await updateBtn.waitFor({ state: "visible", timeout: 5000 }); await updateBtn.click();

  // Capture actual toast text from UI
  const toast = await detectToast(page, "Risk updated successfully");

  // Wait after update for UI to settle before next action
  await page.waitForTimeout(2000);

  return { success: toast.detected, toastText: toast.actualText };
}

async function performStatusWorkflow(input: StatusWorkflowInput): Promise<StatusWorkflowResult> {
  let context: BrowserContext | null = null;
  const statusSequence = ["Open", "In Review", "Mitigated", "Closed"];
  const steps: StepResult[] = [];
  const actualSequence: string[] = [];

  const result: StatusWorkflowResult = {
    status: "error", message: "", riskTitle: input.title,
    assertion: { expected: statusSequence.join(" → "), actual: "", match: false },
    steps: [], versions_created: 0,
    screenshots: { final_status: null, failure: null },
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page = await context.newPage();

    // Login
    console.log(`[Status] Logging in as ${input.username}...`);
    if (!(await performLogin(page, input.username, input.password))) {
      result.status = "fail"; result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_login_failed");
      await context.close(); return result;
    }
    console.log("[Status] Login successful");

    // Create risk
    console.log("[Status] Creating risk...");
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(3000);

    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10000 }); await addBtn.click();
    await page.waitForTimeout(2000);

    await fillRiskForm(page, { title: input.title, description: input.description, category: input.category, status: "Open", impact: input.impact, likelihood: input.likelihood, owner: input.owner, dueDate: input.dueDate, potentialCost: input.potentialCost, mitigationPlan: input.mitigationPlan });

    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5000 }); await saveBtn.click();

    const createToast = await detectToast(page, "Risk created successfully");
    if (!createToast.detected) {
      result.status = "fail"; result.message = "Risk creation failed";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_create_failed");
      result.steps = steps; await context.close(); return result;
    }
    console.log("[Status] Risk created");

    // Step 1: Verify Open
    console.log("[Status] Verifying initial status: Open...");
    const openCheck = await verifyRiskStatus(page, input.title, "Open");
    steps.push({ step: "create", status: openCheck.actual === "Open" ? "pass" : "fail", expected_status: "Open", actual_status: openCheck.actual, version: openCheck.versionCount });
    if (openCheck.actual === "Open") { actualSequence.push("Open"); console.log("[Status] ✓ Open"); }
    else { console.log(`[Status] ✗ Expected Open, got ${openCheck.actual}`); const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_open_failed"); }

    // Step 2: Open → In Review
    console.log("[Status] Updating: Open → In Review...");
    const inReviewResult = await updateRiskStatus(page, input.title, "In Review");
    if (inReviewResult.success) {
      // Wait before verifying to let UI update
      await page.waitForTimeout(2000);
      const check = await verifyRiskStatus(page, input.title, "In Review");
      steps.push({ step: "update_in_review", status: check.actual === "In Review" ? "pass" : "fail", expected_status: "In Review", actual_status: check.actual, version: check.versionCount });
      if (check.actual === "In Review") { actualSequence.push("In Review"); console.log(`[Status] ✓ In Review (toast: "${inReviewResult.toastText}")`); }
      else { console.log(`[Status] ✗ Expected In Review, got ${check.actual}`); }
    } else {
      steps.push({ step: "update_in_review", status: "fail", expected_status: "In Review", actual_status: null, version: null });
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_in_review_failed");
    }

    // Step 3: In Review → Mitigated
    console.log("[Status] Updating: In Review → Mitigated...");
    const mitigatedResult = await updateRiskStatus(page, input.title, "Mitigated");
    if (mitigatedResult.success) {
      await page.waitForTimeout(2000);
      const check = await verifyRiskStatus(page, input.title, "Mitigated");
      steps.push({ step: "update_mitigated", status: check.actual === "Mitigated" ? "pass" : "fail", expected_status: "Mitigated", actual_status: check.actual, version: check.versionCount });
      if (check.actual === "Mitigated") { actualSequence.push("Mitigated"); console.log(`[Status] ✓ Mitigated (toast: "${mitigatedResult.toastText}")`); }
      else { console.log(`[Status] ✗ Expected Mitigated, got ${check.actual}`); }
    } else {
      steps.push({ step: "update_mitigated", status: "fail", expected_status: "Mitigated", actual_status: null, version: null });
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_mitigated_failed");
    }

    // Step 4: Mitigated → Closed
    console.log("[Status] Updating: Mitigated → Closed...");
    const closedResult = await updateRiskStatus(page, input.title, "Closed");
    if (closedResult.success) {
      await page.waitForTimeout(2000);
      const check = await verifyRiskStatus(page, input.title, "Closed");
      steps.push({ step: "update_closed", status: check.actual === "Closed" ? "pass" : "fail", expected_status: "Closed", actual_status: check.actual, version: check.versionCount });
      if (check.actual === "Closed") { actualSequence.push("Closed"); console.log(`[Status] ✓ Closed (toast: "${closedResult.toastText}")`); }
      else { console.log(`[Status] ✗ Expected Closed, got ${check.actual}`); }
      result.versions_created = check.versionCount;
    } else {
      steps.push({ step: "update_closed", status: "fail", expected_status: "Closed", actual_status: null, version: null });
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_closed_failed");
    }

    // Final screenshot
    const finalShot = await page.screenshot({ fullPage: true });
    result.screenshots.final_status = await uploadScreenshot(finalShot, "status_final");

    // Build result
    result.steps = steps;
    result.assertion.actual = actualSequence.join(" → ");
    result.assertion.match = result.assertion.expected === result.assertion.actual;

    const allPassed = steps.every(s => s.status === "pass");
    result.status = allPassed ? "pass" : "fail";
    result.message = allPassed ? "All status transitions completed successfully" : `Some transitions failed. Actual: ${result.assertion.actual}`;

    console.log(`[Status] Expected: ${result.assertion.expected}`);
    console.log(`[Status] Actual:   ${result.assertion.actual}`);
    console.log(`[Status] Match:    ${result.assertion.match}`);
    console.log(`[Status] Versions: ${result.versions_created}`);

    await context.close(); return result;
  } catch (error) {
    if (context) { try { const p = context.pages(); if (p.length > 0) { const s = await p[0].screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_error"); } } catch {} await context.close().catch(() => {}); }
    result.status = "error"; result.message = (error as Error).message; result.steps = steps; return result;
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) { next(); return; }
  if (req.headers["x-api-key"] !== config.apiKey) { res.status(401).json({ status: "error", message: "Unauthorized" }); return; }
  next();
}

app.post("/create-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<RiskInput>;
  if (!input.username || !input.password || !input.title) { res.status(400).json({ status: "error", message: "Missing: username, password, title" }); return; }
  const full: RiskInput = { username: input.username, password: input.password, title: input.title, description: input.description || "", category: input.category || "Technical", status: input.status || "Open", impact: input.impact || "3 - Medium", likelihood: input.likelihood || "3 - Medium", owner: input.owner || "", dueDate: input.dueDate || "", potentialCost: input.potentialCost || "", mitigationPlan: input.mitigationPlan || "" };
  const result = await performCreateRisk(full);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/edit-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<EditRiskInput>;
  if (!input.username || !input.password || !input.searchTitle) { res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" }); return; }
  const result = await performEditRisk(input as EditRiskInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/delete-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<DeleteRiskInput>;
  if (!input.username || !input.password || !input.searchTitle) { res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" }); return; }
  const result = await performDeleteRisk(input as DeleteRiskInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/risk-status-workflow", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<StatusWorkflowInput>;
  if (!input.username || !input.password || !input.title) { res.status(400).json({ status: "error", message: "Missing: username, password, title" }); return; }
  const full: StatusWorkflowInput = { username: input.username, password: input.password, title: input.title, description: input.description || "Status workflow test risk", category: input.category || "Technical", impact: input.impact || "3 - Medium", likelihood: input.likelihood || "3 - Medium", owner: input.owner || "", dueDate: input.dueDate || "", potentialCost: input.potentialCost || "", mitigationPlan: input.mitigationPlan || "" };
  const result = await performStatusWorkflow(full);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "running", service: "captus-risk-bot", endpoints: ["/create-risk", "/edit-risk", "/delete-risk", "/risk-status-workflow"], browserConnected: browserInstance?.isConnected() ?? false, timestamp: new Date().toISOString() });
});

// ─── Start & Shutdown ────────────────────────────────────────────────────────

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Risk Bot running on port ${config.port}`);
  console.log(`Dashboard: ${config.dashboardUrl}`);
  console.log(`Table: ${config.tableUrl}`);
  console.log(`Screenshots: ${config.supabaseUrl ? "ENABLED" : "DISABLED"}`);
  console.log(`Auth: ${config.apiKey ? "ENABLED" : "DISABLED"}`);
});

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  server.close(); await closeBrowser(); process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
