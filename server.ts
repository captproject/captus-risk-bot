import express, { Request, Response, NextFunction } from "express";
import { chromium, Browser, BrowserContext, Page, Route } from "playwright";

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

interface ScoreMatrixInput {
  username: string;
  password: string;
  impact: string;
  likelihood: string;
  expectedScore: number;
}

interface ScoreMatrixResult {
  status: "pass" | "fail" | "error";
  message: string;
  username: string;
  impact: string;
  likelihood: string;
  expected_score: number;
  actual_score: number | null;
  score_match: boolean;
  risk_title: string;
  cleaned_up: boolean;
  screenshots: { failure: string | null };
}

interface AuditLogInput {
  username: string;
  password: string;
  chatMessage?: string;
}

interface AuditStepResult {
  status: "pass" | "fail";
  filter_used: string;
  expected_action: string;
  actual_action: string | null;
  expected_entity: string;
  actual_entity: string | null;
  expected_severity: string;
  actual_severity: string | null;
  summary_contains: string;
  summary_found: boolean;
  action_match: boolean;
  entity_match: boolean;
  severity_match: boolean;
  error?: string;
}

interface AuditLogResult {
  status: "pass" | "fail" | "error";
  message: string;
  username: string;
  risk_title: string;
  steps_summary: string;
  total_steps: number;
  passed: number;
  failed: number;
  steps: Record<string, AuditStepResult>;
  screenshots: { failure: string | null };
}

interface Config {
  loginUrl: string;
  dashboardUrl: string;
  tableUrl: string;
  auditUrl: string;
  apiKey: string;
  supabaseUrl: string;
  supabaseKey: string;
  port: number;
  navigationTimeout: number;
  executionTimeout: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const config: Config = {
  loginUrl: process.env.LOGIN_URL || "https://captus.replit.app/login",
  dashboardUrl: process.env.DASHBOARD_URL || "https://captus.replit.app/dashboard",
  tableUrl: process.env.TABLE_URL || "https://captus.replit.app/table",
  auditUrl: process.env.AUDIT_URL || "https://captus.replit.app/admin/audit",
  apiKey: process.env.API_KEY || "",
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_KEY || "",
  port: Number(process.env.PORT) || 3000,
  navigationTimeout: 60_000,
  executionTimeout: 120_000,
};

const KNOWN_STATUSES = ["Open", "In Review", "Mitigated", "Closed"] as const;
const KNOWN_CATEGORIES = [
  "Budget", "Schedule", "Safety", "Quality", "Environmental",
  "Legal", "Technical", "Resource", "Other",
] as const;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const BLOCKED_RESOURCE_TYPES = ["image", "media", "font"];
const BLOCKED_URL_PATTERNS = [
  "google-analytics.com", "googletagmanager.com", "facebook.net",
  "hotjar.com", "intercom.io", "sentry.io", "mixpanel.com",
  "segment.io", "amplitude.com", "clarity.ms",
  "cdn.gpteng.co", "replit-cdn.com",
];

// ─── Execution Queue (Single Concurrency) ────────────────────────────────────

class ExecutionQueue {
  private queue: Array<{
    execute: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
  }> = [];
  private running = false;

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ execute: fn, resolve, reject });
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    console.log(`[Queue] Starting task. Pending: ${this.queue.length}`);
    try {
      const result = await next.execute();
      next.resolve(result);
    } catch (err) {
      next.reject(err);
    } finally {
      this.running = false;
      console.log(`[Queue] Task complete. Pending: ${this.queue.length}`);
      this.process();
    }
  }

  get pendingCount(): number { return this.queue.length; }
  get isRunning(): boolean { return this.running; }
}

const executionQueue = new ExecutionQueue();

// ─── Timeout Guard ───────────────────────────────────────────────────────────

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Timeout] ${label} exceeded ${timeoutMs / 1000}s limit — killed`));
    }, timeoutMs);
    fn().then((r) => { clearTimeout(timer); resolve(r); }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ─── Browser Pool ────────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && !browserInstance.isConnected()) {
    console.log("[Browser] Found stale instance — cleaning up");
    browserInstance = null;
    invalidateSession();
  }
  if (browserInstance?.isConnected()) return browserInstance;

  console.log("[Browser] Launching with memory-optimized flags");
  browserInstance = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--disable-software-rasterizer", "--no-zygote",
      "--disable-extensions", "--disable-background-networking",
      "--disable-default-apps", "--disable-sync", "--disable-translate",
      "--disable-notifications", "--disable-component-update",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-ipc-flooding-protection",
      "--disable-canvas-aa", "--disable-2d-canvas-clip-aa",
      "--disable-accelerated-2d-canvas", "--disable-web-security",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process",
      "--js-flags=--max-old-space-size=256 --max-semi-space-size=2 --gc-interval=100",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-hang-monitor", "--mute-audio", "--no-first-run",
      "--font-render-hinting=none", "--disable-remote-fonts",
    ],
  });

  browserInstance.on("disconnected", () => {
    console.log("[Browser] Disconnected — clearing instance and session");
    browserInstance = null;
    invalidateSession();
  });

  return browserInstance;
}

async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
    console.log("[Browser] Closed and memory released");
  }
}

// ─── Session Reuse ───────────────────────────────────────────────────────────

interface CachedSession {
  cookies: any[];
  localStorage: Record<string, string>;
  username: string;
  loginTime: number;
}

const SESSION_TTL = 5 * 60 * 1000;
let cachedSession: CachedSession | null = null;

async function saveSession(context: BrowserContext, username: string): Promise<void> {
  try {
    const cookies = await context.cookies();
    const pages = context.pages();
    let localStorage: Record<string, string> = {};
    if (pages.length > 0) {
      localStorage = await pages[0].evaluate(() => {
        const data: Record<string, string> = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key) data[key] = window.localStorage.getItem(key) || "";
        }
        return data;
      }).catch(() => ({}));
    }
    cachedSession = { cookies, localStorage, username, loginTime: Date.now() };
    console.log(`[Session] Saved session for ${username} (${cookies.length} cookies)`);
  } catch (err) {
    console.log(`[Session] Failed to save: ${(err as Error).message}`);
  }
}

async function restoreSession(context: BrowserContext, username: string): Promise<boolean> {
  if (!cachedSession) return false;
  if (cachedSession.username !== username) return false;
  if (Date.now() - cachedSession.loginTime > SESSION_TTL) {
    console.log("[Session] Expired — will re-login");
    cachedSession = null;
    return false;
  }
  try {
    await context.addCookies(cachedSession.cookies);
    console.log(`[Session] Restored session for ${username}`);
    return true;
  } catch (err) {
    console.log(`[Session] Restore failed: ${(err as Error).message}`);
    return false;
  }
}

function invalidateSession(): void {
  cachedSession = null;
  console.log("[Session] Invalidated");
}

// ─── Resource Blocking ───────────────────────────────────────────────────────

async function enableResourceBlocking(context: BrowserContext): Promise<void> {
  await context.route("**/*", (route: Route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();
    if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) { route.abort().catch(() => {}); return; }
    if (BLOCKED_URL_PATTERNS.some((p) => url.includes(p))) { route.abort().catch(() => {}); return; }
    route.continue().catch(() => {});
  });
  console.log("[Resources] Blocking images, fonts, media, stylesheets, and trackers");
}

// ─── Result Storage ──────────────────────────────────────────────────────────

async function saveTestResult(
  workflowName: string,
  common: {
    status: string; username: string; risk_title?: string | null;
    message?: string | null; assertion_expected?: string | null;
    assertion_actual?: string | null; assertion_match?: boolean;
    screenshot_failure?: string | null;
    [key: string]: any;
  },
  details: Record<string, any> = {},
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.log("[Result] Supabase not configured — skipping result save");
    return;
  }
  try {
    const row = {
      workflow_name: workflowName,
      status: common.status,
      username: common.username,
      risk_title: common.risk_title || null,
      message: common.message || null,
      assertion_expected: common.assertion_expected || null,
      assertion_actual: common.assertion_actual || null,
      assertion_match: common.assertion_match ?? false,
      screenshot_failure: common.screenshot_failure || null,
      details: JSON.stringify(details),
      executed_at: new Date().toISOString(),
    };
    const response = await fetch(`${config.supabaseUrl}/rest/v1/workflow_results`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (response.ok) console.log(`[Result] Saved ${workflowName} to workflow_results`);
    else console.error(`[Result] Failed: ${await response.text()}`);
  } catch (err) {
    console.error(`[Result] Error: ${(err as Error).message}`);
  }
}

async function saveStepResult(
  runId: string, workflowName: string, stepName: string, stepOrder: number,
  data: {
    status: string; username: string; risk_title?: string | null;
    message?: string | null; assertion_expected?: string | null;
    assertion_actual?: string | null; assertion_match?: boolean;
    screenshot_failure?: string | null;
  },
  details: Record<string, any> = {},
): Promise<void> {
  if (!config.supabaseUrl || !config.supabaseKey) return;
  try {
    const row = {
      run_id: runId, workflow_name: workflowName, step_name: stepName,
      step_order: stepOrder, status: data.status, username: data.username,
      risk_title: data.risk_title || null, message: data.message || null,
      assertion_expected: data.assertion_expected || null,
      assertion_actual: data.assertion_actual || null,
      assertion_match: data.assertion_match ?? false,
      screenshot_failure: data.screenshot_failure || null,
      details: JSON.stringify(details), executed_at: new Date().toISOString(),
    };
    const response = await fetch(`${config.supabaseUrl}/rest/v1/workflow_results`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (response.ok) console.log(`[Result] Saved step ${stepOrder}: ${stepName} (${data.status})`);
    else console.error(`[Result] Failed step ${stepName}: ${await response.text()}`);
  } catch (err) {
    console.error(`[Result] Error step ${stepName}: ${(err as Error).message}`);
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
      },
    );
    if (response.ok) return `${config.supabaseUrl}/storage/v1/object/public/screenshots/${fileName}`;
    console.error(`Screenshot upload failed: ${await response.text()}`);
    return null;
  } catch (err) {
    console.error(`Screenshot upload error: ${(err as Error).message}`);
    return null;
  }
}

async function captureFailure(context: BrowserContext | null, label: string): Promise<string | null> {
  if (!context) return null;
  try {
    const pages = context.pages();
    if (pages.length > 0) {
      const buf = await pages[0].screenshot({ fullPage: true });
      return await uploadScreenshot(buf, label);
    }
  } catch {}
  return null;
}

async function safeClose(context: BrowserContext | null): Promise<void> {
  if (context) await context.close().catch(() => {});
}

// ─── Helper: Retry wrapper ───────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 3, delayMs = 2_000): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (err) {
      lastError = err as Error;
      console.log(`[Retry] ${label} — attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// ─── Helper: Select Dropdown ─────────────────────────────────────────────────

async function selectDropdown(page: Page, triggerTestId: string, optionText: string): Promise<boolean> {
  try {
    const trigger = page.getByTestId(triggerTestId);
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    await trigger.click();
    const option = page.getByRole("option", { name: optionText });
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click();
    await page.getByRole("listbox").waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
    return true;
  } catch {
    console.log(`[Dropdown] Locator failed for "${triggerTestId}" → "${optionText}", using evaluate fallback`);
  }
  const clicked = await page.evaluate((testId) => {
    const btn = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
    if (btn) { btn.click(); return true; }
    return false;
  }, triggerTestId);
  if (!clicked) return false;
  await page.getByRole("option").first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
  const selected = await page.evaluate((text) => {
    const options = document.querySelectorAll('[role="option"]');
    for (const opt of options) {
      if (opt.textContent?.trim().includes(text)) { (opt as HTMLElement).click(); return true; }
    }
    return false;
  }, optionText);
  return selected;
}

// ─── Helper: Set Due Date ────────────────────────────────────────────────────

async function setDueDate(page: Page, dateString: string): Promise<void> {
  const [yearStr, monthStr, dayStr] = dateString.split("-");
  const targetYear = parseInt(yearStr);
  const targetMonth = parseInt(monthStr);
  const targetDay = parseInt(dayStr).toString();
  const targetMonthYear = `${MONTH_NAMES[targetMonth - 1]} ${targetYear}`;
  console.log(`[DueDate] Target: ${targetMonthYear}, day ${targetDay}`);

  const dateButton = page.getByTestId("button-risk-due-date");
  await dateButton.waitFor({ state: "visible", timeout: 10_000 });
  await dateButton.click();
  await page.locator('[role="grid"]').first().waitFor({ state: "visible", timeout: 5_000 });

  for (let i = 0; i < 24; i++) {
    const headingText = await page.locator('[class*="rdp"], [id^="react-day-picker"]').first().textContent().catch(() => "");
    if (headingText?.includes(targetMonthYear)) { console.log("[DueDate] Correct month found"); break; }
    const nextBtn = page.locator('button[name="next-month"]')
      .or(page.locator('button[aria-label="Go to next month"]'))
      .or(page.locator('button[aria-label="Go to the next month"]'))
      .or(page.locator(".rdp-nav button:last-child"));
    const nextVisible = await nextBtn.first().isVisible().catch(() => false);
    if (nextVisible) await nextBtn.first().click();
    else { console.log("[DueDate] Could not find next-month button"); break; }
    await page.waitForTimeout(300);
  }

  console.log(`[DueDate] Clicking day: ${targetDay}`);
  const dayButton = page.locator('[role="gridcell"] button')
    .filter({ hasText: new RegExp(`^${targetDay}$`) })
    .and(page.locator(":not([disabled])"));
  const dayCount = await dayButton.count();
  if (dayCount > 0) await dayButton.first().click();
  else {
    await page.evaluate((day) => {
      const cells = document.querySelectorAll('[role="gridcell"]');
      for (const cell of cells) {
        const button = cell.querySelector("button");
        const textEl = button || cell;
        if (textEl.textContent?.trim() === day && !button?.hasAttribute("disabled") && cell.getAttribute("aria-disabled") !== "true") {
          (button || (cell as HTMLElement)).click(); return;
        }
      }
    }, targetDay);
  }
  await page.locator('[role="grid"]').first().waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
  console.log("[DueDate] Due date set");
}

// ─── Helper: Search for Risk ─────────────────────────────────────────────────

async function searchRisk(page: Page, title: string): Promise<void> {
  console.log(`[Search] Searching for: "${title}"`);
  const searchInput = page.getByTestId("input-search-risks");
  await searchInput.waitFor({ state: "visible", timeout: 10_000 });
  await searchInput.fill(title);
  await page.waitForTimeout(1_500);
  console.log("[Search] Done");
}

// ─── Helper: Detect Toast ────────────────────────────────────────────────────

async function detectToast(page: Page, expectedText: string): Promise<ToastResult> {
  console.log(`[Toast] Watching for: "${expectedText}"`);
  const result: ToastResult = { detected: false, actualText: null, expectedText, match: false };
  const toastLocator = page.locator('[data-sonner-toast]')
    .or(page.locator('[role="status"]'))
    .or(page.locator('[data-radix-toast-viewport] > *'))
    .or(page.locator('[class*="Toastify"]'));
  try {
    await toastLocator.first().waitFor({ state: "visible", timeout: 6_000 });
    const toastText = await toastLocator.first().textContent();
    if (toastText?.trim()) {
      result.detected = true;
      result.actualText = toastText.trim();
      result.match = result.actualText.toLowerCase().includes(expectedText.toLowerCase());
    }
  } catch {
    const fallbackText = await page.evaluate(() => {
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        const t = el.textContent?.trim() || "";
        if (el.children.length <= 2 && t.toLowerCase().includes("successfully") && t.length < 100) return t;
      }
      return null;
    });
    if (fallbackText) {
      result.detected = true;
      result.actualText = fallbackText;
      result.match = fallbackText.toLowerCase().includes(expectedText.toLowerCase());
    }
  }
  console.log(`[Toast] Detected: ${result.detected} | Actual: "${result.actualText}" | Match: ${result.match}`);
  return result;
}

// ─── Helper: Fill Risk Form ──────────────────────────────────────────────────

async function fillRiskForm(page: Page, data: {
  title?: string; description?: string; category?: string; status?: string;
  impact?: string; likelihood?: string; owner?: string; dueDate?: string;
  potentialCost?: string; mitigationPlan?: string;
}): Promise<void> {
  if (data.title) {
    console.log(`[Form] Title: "${data.title}"`);
    const f = page.getByTestId("input-risk-title"); await f.waitFor({ state: "visible", timeout: 5_000 }); await f.clear(); await f.fill(data.title);
  }
  if (data.description) {
    console.log("[Form] Description");
    const f = page.getByTestId("input-risk-description"); await f.waitFor({ state: "visible", timeout: 5_000 }); await f.clear(); await f.fill(data.description);
  }
  if (data.category) { console.log(`[Form] Category: "${data.category}"`); await selectDropdown(page, "select-risk-category", data.category); }
  if (data.status) { console.log(`[Form] Status: "${data.status}"`); await selectDropdown(page, "select-risk-status", data.status); }
  if (data.impact) { console.log(`[Form] Impact: "${data.impact}"`); await selectDropdown(page, "select-risk-impact", data.impact); }
  if (data.likelihood) { console.log(`[Form] Likelihood: "${data.likelihood}"`); await selectDropdown(page, "select-risk-likelihood", data.likelihood); }
  if (data.owner) {
    console.log(`[Form] Owner: "${data.owner}"`);
    const f = page.getByTestId("input-risk-owner"); await f.waitFor({ state: "visible", timeout: 5_000 }); await f.clear(); await f.fill(data.owner);
  }
  if (data.dueDate) { console.log(`[Form] Due date: "${data.dueDate}"`); await setDueDate(page, data.dueDate); }
  if (data.potentialCost) {
    console.log(`[Form] Cost: "${data.potentialCost}"`);
    const f = page.getByTestId("input-risk-potential-cost"); await f.waitFor({ state: "visible", timeout: 5_000 }); await f.clear(); await f.fill(data.potentialCost);
  }
  if (data.mitigationPlan) {
    console.log("[Form] Mitigation plan");
    const f = page.getByTestId("input-risk-mitigation"); await f.waitFor({ state: "visible", timeout: 5_000 }); await f.clear(); await f.fill(data.mitigationPlan);
  }
}

// ─── Helper: Select Company ──────────────────────────────────────────────────

async function selectCompany(page: Page, companyName = "demo"): Promise<boolean> {
  try {
    console.log(`[Company] Selecting company: "${companyName}"`);
    const companyBtn = page.getByTestId("button-company-selector");
    await companyBtn.waitFor({ state: "visible", timeout: 10_000 });
    await companyBtn.click();
    await page.locator('[role="menuitem"]').first().waitFor({ state: "visible", timeout: 5_000 });
    const companyOption = page.locator('[role="menuitem"]').filter({ hasText: companyName }).first();
    await companyOption.waitFor({ state: "visible", timeout: 5_000 });
    await companyOption.click();
    await page.waitForTimeout(2_000);
    console.log(`[Company] Selected "${companyName}" successfully`);
    return true;
  } catch (err) {
    console.log(`[Company] Failed to select "${companyName}": ${(err as Error).message}`);
    return false;
  }
}

// ─── Core Login ──────────────────────────────────────────────────────────────

async function performLogin(page: Page, username: string, password: string): Promise<boolean> {
  return withRetry(async () => {
    await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    const emailInput = page.locator('input[name="email"]');
    await emailInput.waitFor({ state: "visible", timeout: 15_000 });
    await emailInput.fill(username);
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.waitFor({ state: "visible", timeout: 5_000 });
    await passwordInput.fill(password);
    const loginBtn = page.getByTestId("button-login");
    await loginBtn.waitFor({ state: "visible", timeout: 5_000 });
    await loginBtn.click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15_000 }).catch(() => {});
    const loggedIn = !page.url().includes("/login");
    console.log(`[Login] ${loggedIn ? "Success" : "Failed"} — URL: ${page.url()}`);
    if (!loggedIn) throw new Error("Login failed — still on /login page");
    return true;
  }, "Login", 3, 2_000).catch(() => false);
}

async function loginWithSession(context: BrowserContext, page: Page, username: string, password: string): Promise<boolean> {
  const restored = await restoreSession(context, username);
  if (restored) {
    try {
      await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
      await page.waitForTimeout(1_500);
      const onLogin = page.url().includes("/login");
      if (!onLogin) {
        const companyBtn = page.getByTestId("button-company-selector");
        const btnText = await companyBtn.textContent().catch(() => "");
        if (btnText?.includes("All Companies")) {
          console.log("[Session] Company not selected — selecting demo");
          await selectCompany(page, "demo");
        }
        console.log(`[Session] Reused session for ${username} — skipped login`);
        return true;
      }
      console.log("[Session] Session expired — falling back to login");
      invalidateSession();
    } catch {
      console.log("[Session] Restore navigation failed — falling back to login");
      invalidateSession();
    }
  }
  const loggedIn = await performLogin(page, username, password);
  if (loggedIn) {
    console.log(`[Login] Post-login URL: ${page.url()}`);
    const companySelected = await selectCompany(page, "demo");
    if (!companySelected) console.log("[Login] WARNING: Could not select company — proceeding anyway");
    await saveSession(context, username);
  }
  return loggedIn;
}

// ─── Helper: Navigate with retry ─────────────────────────────────────────────

async function navigateTo(page: Page, url: string): Promise<void> {
  await withRetry(async () => {
    await page.goto(url, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(2_000);
  }, `Navigate to ${url}`, 2, 1_500);
}

// ─── Helper: Click edit button ───────────────────────────────────────────────

async function clickFirstEditButton(page: Page): Promise<boolean> {
  const editBtn = page.locator('[data-testid^="button-edit-heatmap-risk-"]').first();
  try {
    await editBtn.waitFor({ state: "visible", timeout: 5_000 });
    await editBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    console.log("[Edit] Edit button not found or form didn't open");
    return false;
  }
}

// ─── Helper: Assert risk visible ─────────────────────────────────────────────

async function riskVisibleInPage(page: Page, title: string): Promise<boolean> {
  try {
    await page.locator("body").filter({ hasText: title }).waitFor({ state: "visible", timeout: 3_000 });
    return true;
  } catch { return false; }
}

// ─── Helper: Create optimized context ────────────────────────────────────────

async function createOptimizedContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  let attempts = 0;
  const maxAttempts = 2;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const browser = await getBrowser();
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      context.setDefaultTimeout(config.navigationTimeout);
      await enableResourceBlocking(context);
      const testPage = await context.newPage();
      return { browser, context };
    } catch (err) {
      console.log(`[Context] Creation failed (attempt ${attempts}/${maxAttempts}): ${(err as Error).message}`);
      await closeBrowser();
      invalidateSession();
      if (attempts >= maxAttempts) throw err;
      console.log("[Context] Retrying with fresh browser...");
    }
  }
  throw new Error("Failed to create browser context after retries");
}

// ─── Helper: Read risk row data from table ───────────────────────────────────

interface RiskRowData {
  title: string | null; category: string | null; status: string | null;
  score: string | null; owner: string | null; cost: string | null;
}

async function readRiskRowFromTable(page: Page, title: string): Promise<RiskRowData | null> {
  try {
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, title);
    await page.waitForTimeout(1_500);
    const rowData = await page.evaluate((riskTitle) => {
      const allRows = document.querySelectorAll("tr, [class*='border-b']");
      for (const row of allRows) {
        if (!row.textContent?.includes(riskTitle)) continue;
        const badges = row.querySelectorAll("div.inline-flex");
        let category: string | null = null;
        let status: string | null = null;
        const knownStatuses = ["Open", "In Review", "Mitigated", "Closed"];
        const knownCategories = ["Budget", "Schedule", "Safety", "Quality", "Environmental", "Legal", "Technical", "Resource", "Other"];
        for (const badge of badges) {
          const badgeText = badge.textContent?.trim() || "";
          if (knownStatuses.includes(badgeText)) status = badgeText;
          if (knownCategories.includes(badgeText)) category = badgeText;
        }
        let score: string | null = null;
        const allEls = row.querySelectorAll("*");
        for (const el of allEls) {
          const t = el.textContent?.trim() || "";
          if (el.children.length === 0 && /^\d{1,2}$/.test(t) && parseInt(t) >= 1 && parseInt(t) <= 25) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 80) { score = t; break; }
          }
        }
        let owner: string | null = null;
        let cost: string | null = null;
        for (const el of allEls) {
          const t = el.textContent?.trim() || "";
          if (el.children.length === 0 && t.length > 0) {
            if (t.startsWith("$") || t.includes(",")) cost = t;
            else if (t !== riskTitle && t !== "—" && !knownStatuses.includes(t) && !knownCategories.includes(t) && !/^\d{1,2}$/.test(t) && t.length > 1 && t.length < 50 && !t.includes("Risk") && !t.includes(">")) {
              if (!owner) owner = t;
            }
          }
        }
        return { title: riskTitle, category, status, score, owner: owner || "—", cost: cost || "—" };
      }
      return null;
    }, title);
    if (rowData) console.log(`[TableRead] Row found: title="${rowData.title}" cat="${rowData.category}" status="${rowData.status}" score="${rowData.score}"`);
    else console.log(`[TableRead] Row not found for "${title}"`);
    return rowData;
  } catch (err) {
    console.log(`[TableRead] Error: ${(err as Error).message}`);
    return null;
  }
}

// ─── CREATE RISK ─────────────────────────────────────────────────────────────

async function performCreateRisk(input: RiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: input.title,
    assertion: { expected: "Risk created successfully", actual: null, match: false }, screenshots: {},
  };
  try {
    const { context: ctx } = await createOptimizedContext();
    context = ctx;
    const page = context.pages()[0];
    console.log(`[Create] Logging in as ${input.username}`);
    if (!(await loginWithSession(context, page, input.username, input.password))) {
      result.status = "failed"; result.message = "Login failed after 3 retries";
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "create_login_failed");
      await saveTestResult("TC_Create_Risk", { status: "failed", username: input.username, risk_title: input.title, message: result.message, assertion_expected: "All validations pass", assertion_actual: "Login failed", assertion_match: false, screenshot_failure: result.screenshots.failure }, { failure_type: "LOGIN_FAILED", checks: { toast_confirmed: false, dashboard_visible: false, table_search: false, fields_valid: false }, field_mismatches: [] });
      return result;
    }
    await navigateTo(page, config.dashboardUrl);
    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10_000 }); await addBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    await fillRiskForm(page, { title: input.title, description: input.description, category: input.category, status: input.status, impact: input.impact, likelihood: input.likelihood, owner: input.owner, dueDate: input.dueDate, potentialCost: input.potentialCost, mitigationPlan: input.mitigationPlan });
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 }); await saveBtn.click();
    const toast = await detectToast(page, "Risk created successfully");
    result.assertion.actual = toast.actualText; result.assertion.match = toast.match;
    if (!toast.detected) {
      const visible = await riskVisibleInPage(page, input.title);
      if (visible) { result.assertion.actual = "Toast missed — risk found in page"; result.assertion.match = true; }
    }
    if (!result.assertion.match) {
      const s = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(s, "create_failed");
      result.status = "failed"; result.message = "Risk creation could not be confirmed";
      await saveTestResult("TC_Create_Risk", { status: "failed", username: input.username, risk_title: input.title, message: result.message, assertion_expected: "All validations pass", assertion_actual: "Toast not detected, risk not visible", assertion_match: false, screenshot_failure: result.screenshots.failure }, { failure_type: "CREATE_FAILED", checks: { toast_confirmed: false, dashboard_visible: false, table_search: false, fields_valid: false }, field_mismatches: [] });
      return result;
    }
    result.status = "success"; result.message = result.assertion.actual || "Risk created";
    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "create_error");
    result.status = "error"; result.message = (error as Error).message; return result;
  } finally { await safeClose(context); }
}

// ─── EDIT RISK ───────────────────────────────────────────────────────────────

async function performEditRisk(input: EditRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: input.searchTitle,
    assertion: { expected: "Risk updated successfully", actual: null, match: false }, screenshots: {},
  };
  try {
    const { context: ctx } = await createOptimizedContext();
    context = ctx;
    const page = context.pages()[0];
    console.log(`[Edit] Logging in as ${input.username}`);
    if (!(await loginWithSession(context, page, input.username, input.password))) {
      result.status = "failed"; result.message = "Login failed after 3 retries";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "edit_login_failed"); return result;
    }
    await navigateTo(page, config.dashboardUrl);
    await searchRisk(page, input.searchTitle);
    if (!(await clickFirstEditButton(page))) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "edit_btn_not_found");
      result.status = "failed"; result.message = `Edit button not found for: "${input.searchTitle}"`; return result;
    }
    await fillRiskForm(page, { title: input.newTitle, description: input.newDescription, category: input.newCategory, status: input.newStatus, impact: input.newImpact, likelihood: input.newLikelihood, owner: input.newOwner, dueDate: input.newDueDate, potentialCost: input.newPotentialCost, mitigationPlan: input.newMitigationPlan });
    const updateBtn = page.getByTestId("button-save-risk");
    await updateBtn.waitFor({ state: "visible", timeout: 5_000 }); await updateBtn.click();
    const toast = await detectToast(page, "Risk updated successfully");
    result.assertion.actual = toast.actualText; result.assertion.match = toast.match;
    if (!toast.detected && input.newTitle) {
      const visible = await riskVisibleInPage(page, input.newTitle);
      if (visible) { result.assertion.actual = "Toast missed — updated risk found in page"; result.assertion.match = true; }
    }
    if (!result.assertion.match) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "edit_failed");
      result.status = "failed"; result.message = "Risk update could not be confirmed"; return result;
    }
    result.status = "success"; result.message = result.assertion.actual || "Risk updated";
    result.riskTitle = input.newTitle || input.searchTitle; return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "edit_error");
    result.status = "error"; result.message = (error as Error).message; return result;
  } finally { await safeClose(context); }
}

// ─── DELETE RISK ─────────────────────────────────────────────────────────────

async function performDeleteRisk(input: DeleteRiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;
  const result: RiskResult = {
    status: "error", message: "", username: input.username, riskTitle: input.searchTitle,
    assertion: { expected: "Risk deleted successfully", actual: null, match: false }, screenshots: {},
  };
  try {
    const { context: ctx } = await createOptimizedContext();
    context = ctx;
    const page = context.pages()[0];
    console.log(`[Delete] Logging in as ${input.username}`);
    if (!(await loginWithSession(context, page, input.username, input.password))) {
      result.status = "failed"; result.message = "Login failed after 3 retries";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_login_failed"); return result;
    }
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, input.searchTitle);
    const riskRow = page.locator("text=" + input.searchTitle).first();
    try {
      await riskRow.waitFor({ state: "visible", timeout: 5_000 }); await riskRow.click();
    } catch {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_not_found");
      result.status = "failed"; result.message = `Risk not found in table: "${input.searchTitle}"`; return result;
    }
    await page.waitForTimeout(1_500);
    const deleteBtn = page.locator('[data-testid^="button-delete-risk-"]').first();
    try {
      await deleteBtn.waitFor({ state: "visible", timeout: 5_000 }); await deleteBtn.click();
    } catch {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_btn_not_found");
      result.status = "failed"; result.message = "Delete button not found after expanding risk row"; return result;
    }
    const toast = await detectToast(page, "Risk deleted successfully");
    result.assertion.actual = toast.actualText; result.assertion.match = toast.match;
    if (!toast.detected) {
      await searchRisk(page, input.searchTitle);
      const stillExists = await riskVisibleInPage(page, input.searchTitle);
      if (!stillExists) { result.assertion.actual = "Toast missed — risk confirmed removed"; result.assertion.match = true; }
    }
    if (!result.assertion.match) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "delete_failed");
      result.status = "failed"; result.message = "Risk deletion could not be confirmed"; return result;
    }
    result.status = "success"; result.message = result.assertion.actual || "Risk deleted"; return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "delete_error");
    result.status = "error"; result.message = (error as Error).message; return result;
  } finally { await safeClose(context); }
}

// ─── RISK STATUS WORKFLOW ────────────────────────────────────────────────────

async function verifyRiskStatus(page: Page, title: string, expectedStatus: string): Promise<{ actual: string | null; versionCount: number }> {
  await navigateTo(page, config.tableUrl);
  await searchRisk(page, title);
  const statusBadge = page.locator("div.inline-flex").filter({ hasText: new RegExp(`^(${KNOWN_STATUSES.join("|")})$`) }).first();
  let actual: string | null = null;
  try { await statusBadge.waitFor({ state: "visible", timeout: 5_000 }); actual = (await statusBadge.textContent())?.trim() || null; } catch { console.log("[Status] Could not find status badge"); }
  console.log(`[Status] Badge found: "${actual}" (expected: "${expectedStatus}")`);
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

async function updateRiskStatus(page: Page, title: string, newStatus: string): Promise<{ success: boolean; toastText: string | null }> {
  await navigateTo(page, config.dashboardUrl);
  await searchRisk(page, title);
  if (!(await clickFirstEditButton(page))) { console.log("[Status] Edit button not found"); return { success: false, toastText: null }; }
  const dropdownSelected = await selectDropdown(page, "select-risk-status", newStatus);
  if (!dropdownSelected) { console.log(`[Status] Failed to select status: "${newStatus}"`); return { success: false, toastText: null }; }
  const updateBtn = page.getByTestId("button-save-risk");
  await updateBtn.waitFor({ state: "visible", timeout: 5_000 }); await updateBtn.click();
  const toast = await detectToast(page, "Risk updated successfully");
  return { success: toast.detected, toastText: toast.actualText };
}

async function performStatusWorkflow(input: StatusWorkflowInput): Promise<StatusWorkflowResult> {
  let context: BrowserContext | null = null;
  const statusSequence = ["Open", "In Review", "Mitigated", "Closed"];
  const steps: StepResult[] = [];
  const actualSequence: string[] = [];
  const result: StatusWorkflowResult = {
    status: "error", message: "", riskTitle: input.title,
    assertion: { expected: statusSequence.join(" -> "), actual: "", match: false },
    steps: [], versions_created: 0, screenshots: { final_status: null, failure: null },
  };
  try {
    const { context: ctx } = await createOptimizedContext();
    context = ctx;
    const page = context.pages()[0];
    console.log(`[Workflow] Logging in as ${input.username}`);
    if (!(await loginWithSession(context, page, input.username, input.password))) {
      result.status = "fail"; result.message = "Login failed after 3 retries";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_login_failed"); return result;
    }
    await navigateTo(page, config.dashboardUrl);
    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10_000 }); await addBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    await fillRiskForm(page, { title: input.title, description: input.description, category: input.category, status: "Open", impact: input.impact, likelihood: input.likelihood, owner: input.owner, dueDate: input.dueDate, potentialCost: input.potentialCost, mitigationPlan: input.mitigationPlan });
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 }); await saveBtn.click();
    const createToast = await detectToast(page, "Risk created successfully");
    if (!createToast.detected) {
      const visible = await riskVisibleInPage(page, input.title);
      if (!visible) {
        result.status = "fail"; result.message = "Risk creation failed";
        const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "status_create_failed");
        result.steps = steps; return result;
      }
    }
    console.log("[Workflow] Step 1: Verify Open");
    const openCheck = await verifyRiskStatus(page, input.title, "Open");
    steps.push({ step: "create", status: openCheck.actual === "Open" ? "pass" : "fail", expected_status: "Open", actual_status: openCheck.actual, version: openCheck.versionCount });
    if (openCheck.actual === "Open") { actualSequence.push("Open"); console.log("[Workflow] OK: Open"); }
    else console.log(`[Workflow] FAIL: Expected Open, got "${openCheck.actual}"`);
    const transitions = [
      { step: "update_in_review", target: "In Review" },
      { step: "update_mitigated", target: "Mitigated" },
      { step: "update_closed", target: "Closed" },
    ];
    for (const { step, target } of transitions) {
      console.log(`[Workflow] Transitioning to: "${target}"`);
      const updateResult = await updateRiskStatus(page, input.title, target);
      if (!updateResult.success) {
        steps.push({ step, status: "fail", expected_status: target, actual_status: null, version: null });
        const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, `status_${target.toLowerCase().replace(" ", "_")}_failed`);
        continue;
      }
      const check = await verifyRiskStatus(page, input.title, target);
      steps.push({ step, status: check.actual === target ? "pass" : "fail", expected_status: target, actual_status: check.actual, version: check.versionCount });
      if (check.actual === target) { actualSequence.push(target); console.log(`[Workflow] OK: ${target}`); }
      else console.log(`[Workflow] FAIL: Expected "${target}", got "${check.actual}"`);
      if (step === "update_closed") result.versions_created = check.versionCount;
    }
    const finalShot = await page.screenshot({ fullPage: true });
    result.screenshots.final_status = await uploadScreenshot(finalShot, "status_final");
    result.steps = steps;
    result.assertion.actual = actualSequence.join(" -> ");
    result.assertion.match = result.assertion.expected === result.assertion.actual;
    const allPassed = steps.every((s) => s.status === "pass");
    result.status = allPassed ? "pass" : "fail";
    result.message = allPassed ? "All status transitions completed successfully" : `Some transitions failed. Actual: ${result.assertion.actual}`;
    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "status_error");
    result.status = "error"; result.message = (error as Error).message; result.steps = steps; return result;
  } finally { await safeClose(context); }
}

// ─── FILTER RISKS ────────────────────────────────────────────────────────────

async function extractTableRows(page: Page): Promise<FilterRowData[]> {
  console.log("[Filter] Extracting table rows");
  const rows: FilterRowData[] = await page.evaluate(({ statuses, categories }) => {
    const results: FilterRowData[] = [];
    const allBadges = document.querySelectorAll("div.inline-flex");
    const processedRows = new Set<Element>();
    for (const badge of allBadges) {
      let rowEl: HTMLElement | null = badge.parentElement;
      while (rowEl && rowEl.tagName !== "TR" && !rowEl.className?.includes("border-b") && !rowEl.className?.includes("row")) rowEl = rowEl.parentElement;
      if (!rowEl || processedRows.has(rowEl)) continue;
      const rowBadges = rowEl.querySelectorAll("div.inline-flex");
      let rowStatus: string | null = null; let rowCategory: string | null = null; let rowTitle = "";
      for (const rb of rowBadges) {
        const rbText = rb.textContent?.trim() || "";
        if (statuses.includes(rbText)) rowStatus = rbText;
        if (categories.includes(rbText)) rowCategory = rbText;
      }
      if (rowStatus || rowCategory) {
        const textEls = rowEl.querySelectorAll("*");
        for (const el of textEls) {
          const elText = el.textContent?.trim() || "";
          if (el.children.length === 0 && elText.length > 3 && elText.length < 300 && !statuses.includes(elText) && !categories.includes(elText) && !/^\d+$/.test(elText) && !elText.startsWith("$") && elText !== "\u2014" && !elText.includes("Risk")) { rowTitle = elText; break; }
        }
        processedRows.add(rowEl);
        results.push({ title: rowTitle, category: rowCategory, status: rowStatus });
      }
    }
    return results;
  }, { statuses: [...KNOWN_STATUSES], categories: [...KNOWN_CATEGORIES] });
  console.log(`[Filter] Extracted ${rows.length} rows`);
  for (const row of rows) console.log(`[Filter]   "${row.title}" | Category: ${row.category} | Status: ${row.status}`);
  return rows;
}

async function performFilterRisks(input: FilterRiskInput): Promise<FilterRiskResult> {
  let context: BrowserContext | null = null;
  const statusFilter = input.statusFilter || "All Status";
  const categoryFilter = input.categoryFilter || "All";
  const result: FilterRiskResult = {
    status: "error", filters: { status: statusFilter, category: categoryFilter },
    assertion: { expected: "All rows match filters", actual: "", match: false },
    total_rows: 0, mismatched_rows: [], screenshots: { failure: null },
  };
  try {
    const { context: ctx } = await createOptimizedContext();
    context = ctx;
    const page = context.pages()[0];
    console.log(`[Filter] Logging in as ${input.username}`);
    if (!(await loginWithSession(context, page, input.username, input.password))) {
      result.status = "fail"; result.assertion.actual = "Login failed after 3 retries";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "filter_login_failed"); return result;
    }
    await navigateTo(page, config.tableUrl);
    if (statusFilter !== "All Status") { console.log(`[Filter] Status filter: "${statusFilter}"`); await selectDropdown(page, "select-status-filter", statusFilter); await page.waitForTimeout(1_500); }
    if (categoryFilter !== "All") { console.log(`[Filter] Category filter: "${categoryFilter}"`); await selectDropdown(page, "select-category-filter", categoryFilter); await page.waitForTimeout(1_500); }
    await page.waitForTimeout(1_000);
    const rows = await extractTableRows(page);
    if (rows.length === 0) {
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "filter_no_rows");
      result.status = "fail"; result.total_rows = 0; result.assertion.actual = "No rows found after applying filters"; return result;
    }
    const mismatched: FilterRowData[] = [];
    for (const row of rows) {
      const statusOk = statusFilter === "All Status" || row.status === statusFilter;
      const categoryOk = categoryFilter === "All" || row.category === categoryFilter;
      if (!statusOk || !categoryOk) { mismatched.push(row); console.log(`[Filter] MISMATCH: "${row.title}" status=${row.status} category=${row.category}`); }
    }
    result.total_rows = rows.length; result.mismatched_rows = mismatched;
    if (mismatched.length === 0) {
      result.status = "pass"; result.assertion.actual = `All ${rows.length} rows matched filters`; result.assertion.match = true;
    } else {
      result.status = "fail"; result.assertion.actual = `${mismatched.length} of ${rows.length} rows did not match`; result.assertion.match = false;
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "filter_mismatch");
    }
    if (statusFilter !== "All Status") await selectDropdown(page, "select-status-filter", "All Status");
    if (categoryFilter !== "All") await selectDropdown(page, "select-category-filter", "All");
    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "filter_error");
    result.status = "error"; result.assertion.actual = (error as Error).message; return result;
  } finally { await safeClose(context); }
}

// ─── SCORE MATRIX ────────────────────────────────────────────────────────────

async function readScoreFromTable(page: Page, title: string): Promise<number | null> {
  return withRetry(async () => {
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, title);
    await page.waitForTimeout(1_500);
    const score = await page.evaluate((riskTitle) => {
      const rows = document.querySelectorAll("tr, [class*='border-b'], [class*='row']");
      for (const row of rows) {
        if (!row.textContent?.includes(riskTitle)) continue;
        const allElements = row.querySelectorAll("*");
        for (const el of allElements) {
          const text = el.textContent?.trim() || "";
          if (el.children.length === 0 && /^\d{1,2}$/.test(text) && parseInt(text) >= 1 && parseInt(text) <= 25) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.width < 100) return parseInt(text);
          }
        }
      }
      return null;
    }, title);
    if (score === null) throw new Error("Score not found in table");
    console.log(`[ScoreMatrix] Read score: ${score} for "${title}"`);
    return score;
  }, "Read score from table", 2, 2_000).catch(() => null);
}

async function deleteRiskFromTable(page: Page, title: string): Promise<boolean> {
  try {
    await navigateTo(page, config.tableUrl);
    await searchRisk(page, title);
    const riskRow = page.locator("text=" + title).first();
    await riskRow.waitFor({ state: "visible", timeout: 5_000 }); await riskRow.click();
    await page.waitForTimeout(1_500);
    const deleteBtn = page.locator('[data-testid^="button-delete-risk-"]').first();
    await deleteBtn.waitFor({ state: "visible", timeout: 5_000 }); await deleteBtn.click();
    const toast = await detectToast(page, "Risk deleted successfully");
    if (toast.detected) { console.log(`[ScoreMatrix] Cleanup: deleted "${title}"`); return true; }
    await searchRisk(page, title);
    const stillExists = await riskVisibleInPage(page, title);
    return !stillExists;
  } catch (err) { console.log(`[ScoreMatrix] Cleanup failed: ${(err as Error).message}`); return false; }
}

async function performScoreMatrix(input: ScoreMatrixInput): Promise<ScoreMatrixResult> {
  let context: BrowserContext | null = null;
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 15);
  const impactShort = input.impact.split(" - ")[1] || input.impact;
  const likelihoodShort = input.likelihood.split(" - ")[1] || input.likelihood;
  const riskTitle = `ScoreTest_${impactShort}_${likelihoodShort}_${timestamp}`;
  const result: ScoreMatrixResult = {
    status: "error", message: "", username: input.username, impact: input.impact,
    likelihood: input.likelihood, expected_score: input.expectedScore, actual_score: null,
    score_match: false, risk_title: riskTitle, cleaned_up: false, screenshots: { failure: null },
  };
  try {
    const { context: ctx } = await createOptimizedContext();
    context = ctx;
    const page = context.pages()[0];
    console.log(`[ScoreMatrix] Testing: ${input.impact} × ${input.likelihood} = ${input.expectedScore}`);
    if (!(await loginWithSession(context, page, input.username, input.password))) {
      result.status = "fail"; result.message = "Login failed";
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "score_login_failed"); return result;
    }
    await navigateTo(page, config.tableUrl);
    const addBtn = page.locator('text=Add Risk').first();
    await addBtn.waitFor({ state: "visible", timeout: 10_000 }); await addBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    await fillRiskForm(page, { title: riskTitle, description: `Score matrix test: ${input.impact} × ${input.likelihood}`, category: "Technical", status: "Open", impact: input.impact, likelihood: input.likelihood });
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 }); await saveBtn.click();
    const toast = await detectToast(page, "Risk created successfully");
    if (!toast.detected) {
      const visible = await riskVisibleInPage(page, riskTitle);
      if (!visible) { result.status = "fail"; result.message = "Risk creation failed"; const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "score_create_failed"); return result; }
    }
    const actualScore = await readScoreFromTable(page, riskTitle);
    result.actual_score = actualScore;
    if (actualScore === null) {
      result.status = "fail"; result.message = `Could not read score from table for "${riskTitle}"`;
      const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "score_read_failed");
      result.cleaned_up = await deleteRiskFromTable(page, riskTitle); return result;
    }
    result.score_match = actualScore === input.expectedScore;
    if (result.score_match) { result.status = "pass"; result.message = `${input.impact} × ${input.likelihood} = ${actualScore} (expected ${input.expectedScore})`; console.log(`[ScoreMatrix] PASS: ${result.message}`); }
    else { result.status = "fail"; result.message = `Score mismatch: got ${actualScore}, expected ${input.expectedScore}`; console.log(`[ScoreMatrix] FAIL: ${result.message}`); const s = await page.screenshot({ fullPage: true }); result.screenshots.failure = await uploadScreenshot(s, "score_mismatch"); }
    result.cleaned_up = await deleteRiskFromTable(page, riskTitle);
    return result;
  } catch (error) {
    result.screenshots.failure = await captureFailure(context, "score_error");
    result.status = "error"; result.message = (error as Error).message; return result;
  } finally { await safeClose(context); }
}

// ─── AUDIT LOG HELPERS ───────────────────────────────────────────────────────

async function navigateToAuditTrail(page: Page): Promise<void> {
  console.log("[Audit] Navigating to audit trail");
  await page.goto(config.auditUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
  await page.waitForTimeout(2_500);
  await page.waitForSelector('[data-testid^="row-audit-log-"]', { timeout: 15_000 }).catch(() => {
    console.log("[Audit] No audit rows visible yet");
  });
}

async function openAuditFilters(page: Page): Promise<void> {
  const actionDropdown = page.locator('[data-testid="select-filter-action"]');
  const isVisible = await actionDropdown.isVisible().catch(() => false);
  if (!isVisible) {
    const filtersBtn = page.locator('[data-testid="button-toggle-filters"]');
    await filtersBtn.waitFor({ state: "visible", timeout: 5_000 });
    await filtersBtn.click();
    await page.waitForTimeout(1_000);
  }
}

async function applyAuditActionFilter(page: Page, actionType: string): Promise<void> {
  console.log(`[Audit] Filtering by: ${actionType}`);
  await openAuditFilters(page);
  const actionDropdown = page.locator('[data-testid="select-filter-action"]');
  await actionDropdown.waitFor({ state: "visible", timeout: 5_000 });
  await actionDropdown.click();
  await page.waitForTimeout(500);
  const option = page.locator('[role="option"]').filter({ hasText: new RegExp(`^${actionType}$`, "i") });
  await option.waitFor({ state: "visible", timeout: 5_000 });
  await option.click();
  await page.waitForTimeout(2_000);
  console.log(`[Audit] Filter applied: ${actionType}`);
}

async function clearAuditFilters(page: Page): Promise<void> {
  const clearBtn = page.locator("text=Clear all");
  const isVisible = await clearBtn.isVisible().catch(() => false);
  if (isVisible) { await clearBtn.click(); await page.waitForTimeout(1_500); console.log("[Audit] Filters cleared"); }
}

async function verifyAuditEntry(
  page: Page, filterAction: string, expectedAction: string,
  expectedEntity: string, expectedSeverity: string, summaryContains: string,
): Promise<AuditStepResult> {
  const result: AuditStepResult = {
    status: "fail", filter_used: filterAction, expected_action: expectedAction,
    actual_action: null, expected_entity: expectedEntity, actual_entity: null,
    expected_severity: expectedSeverity, actual_severity: null,
    summary_contains: summaryContains, summary_found: false,
    action_match: false, entity_match: false, severity_match: false,
  };
  try {
    await navigateToAuditTrail(page);
    await clearAuditFilters(page);
    await applyAuditActionFilter(page, filterAction);
    const rows = page.locator('[data-testid^="row-audit-log-"]');
    const rowCount = await rows.count();
    console.log(`[Audit] ${filterAction}: ${rowCount} rows visible`);
    if (rowCount === 0) { result.error = `No rows found for filter: ${filterAction}`; return result; }
    for (let i = 0; i < Math.min(rowCount, 20); i++) {
      const row = rows.nth(i);
      const summaryText = await row.locator("td:nth-child(5)").textContent().catch(() => "") || "";
      if (summaryText.toLowerCase().includes(summaryContains.toLowerCase())) {
        result.summary_found = true;
        result.actual_action = (await row.locator("td:nth-child(3)").textContent().catch(() => "") || "").trim();
        const entityEl = row.locator("td:nth-child(4) .capitalize").first();
        result.actual_entity = (await entityEl.textContent().catch(() => "") || "").trim();
        result.actual_severity = (await row.locator("td:nth-child(6)").textContent().catch(() => "") || "").trim().toLowerCase();
        result.action_match = result.actual_action?.toLowerCase() === expectedAction.toLowerCase();
        result.entity_match = result.actual_entity?.toLowerCase() === expectedEntity.toLowerCase();
        result.severity_match = result.actual_severity === expectedSeverity.toLowerCase();
        result.status = (result.action_match && result.entity_match && result.severity_match) ? "pass" : "fail";
        console.log(`[Audit] ${filterAction}: found=${result.summary_found} action="${result.actual_action}"(${result.action_match ? "✅" : "❌"}) entity="${result.actual_entity}"(${result.entity_match ? "✅" : "❌"}) severity="${result.actual_severity}"(${result.severity_match ? "✅" : "❌"}) → ${result.status}`);
        return result;
      }
    }
    result.error = `No row with summary containing: "${summaryContains}"`;
    console.log(`[Audit] ${filterAction}: ${result.error}`);
    return result;
  } catch (err) {
    result.error = (err as Error).message;
    console.log(`[Audit] ${filterAction} error: ${result.error}`);
    return result;
  }
}

// ─── AUDIT LOG: CHAT MESSAGE ─────────────────────────────────────────────────

async function sendChatMessage(page: Page, message: string): Promise<boolean> {
  try {
    console.log(`[Chat] Sending: "${message}"`);
    const chatBtn = page.locator('[data-testid="button-chat-widget"]');
    await chatBtn.waitFor({ state: "visible", timeout: 10_000 });
    await chatBtn.click();
    await page.waitForTimeout(1_500);
    const chatInput = page.locator('input[placeholder="Type a message..."]');
    await chatInput.waitFor({ state: "visible", timeout: 5_000 });
    await chatInput.fill(message);
    await page.waitForTimeout(500);
    const sendBtn = page.locator('button[type="submit"].rounded-full');
    await sendBtn.waitFor({ state: "visible", timeout: 5_000 });
    await sendBtn.click();
    await page.waitForTimeout(5_000);
    console.log("[Chat] Message sent");
    return true;
  } catch (err) { console.log(`[Chat] Failed: ${(err as Error).message}`); return false; }
}

// ─── AUDIT LOG: LOGOUT ───────────────────────────────────────────────────────

async function performLogout(page: Page): Promise<boolean> {
  try {
    console.log("[Logout] Starting");
    const avatar = page.locator("div.rounded-full span.text-white").filter({ hasText: /^[A-Z]{1,2}$/ }).first();
    await avatar.waitFor({ state: "visible", timeout: 5_000 });
    await avatar.click();
    await page.waitForTimeout(1_000);
    const logoutBtn = page.locator('[data-testid="menu-item-logout"]');
    await logoutBtn.waitFor({ state: "visible", timeout: 5_000 });
    await logoutBtn.click();
    await page.waitForTimeout(3_000);
    const url = page.url();
    const success = url.includes("/login") || url.includes("/sign-in");
    console.log(`[Logout] ${success ? "Success" : "Failed"} — URL: ${url}`);
    return success;
  } catch (err) { console.log(`[Logout] Failed: ${(err as Error).message}`); return false; }
}

// ─── AUDIT LOG: MAIN FUNCTION ────────────────────────────────────────────────

async function performAuditLog(input: AuditLogInput): Promise<AuditLogResult> {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 15);
  const riskTitle = `AuditTest_${timestamp}`;
  const chatMsg = input.chatMessage || "audit test message";
  const result: AuditLogResult = {
    status: "error", message: "", username: input.username, risk_title: riskTitle,
    steps_summary: "", total_steps: 6, passed: 0, failed: 0,
    steps: {} as Record<string, AuditStepResult>, screenshots: { failure: null },
  };
  let context: BrowserContext | null = null;
  try {
    const { context: ctx } = await createOptimizedContext();
    context = ctx;
    const page = context.pages()[0];

    // ── ACTION 1: Login ──────────────────────────────────────────────────
    console.log("[AuditLog] === ACTION 1: Login ===");
    if (!(await loginWithSession(context, page, input.username, input.password))) {
      result.status = "error"; result.message = "Login failed";
      result.screenshots.failure = await captureFailure(context, "audit_login_fail"); return result;
    }

    // ── ACTION 2: Create Risk ────────────────────────────────────────────
    console.log("[AuditLog] === ACTION 2: Create Risk ===");
    await navigateTo(page, config.dashboardUrl);
    await page.waitForTimeout(1_500);
    const addBtn = page.getByTestId("button-add-risk");
    await addBtn.waitFor({ state: "visible", timeout: 10_000 }); await addBtn.click();
    await page.getByTestId("input-risk-title").waitFor({ state: "visible", timeout: 5_000 });
    await fillRiskForm(page, { title: riskTitle, description: "Audit log test risk", category: "Technical", status: "Open", impact: "3 - Medium", likelihood: "3 - Medium" });
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5_000 }); await saveBtn.click();
    const createToast = await detectToast(page, "Risk created successfully");
    console.log(`[AuditLog] Create: ${createToast.match ? "OK" : "FAIL"}`);
    await page.waitForTimeout(2_000);

    // ── ACTION 3: Edit Risk ──────────────────────────────────────────────
    console.log("[AuditLog] === ACTION 3: Edit Risk ===");
    await navigateTo(page, config.dashboardUrl);
    await page.waitForTimeout(1_500);
    await searchRisk(page, riskTitle);
    if (await clickFirstEditButton(page)) {
      await fillRiskForm(page, { description: "Updated by audit log test" });
      const updateBtn = page.getByTestId("button-save-risk");
      await updateBtn.waitFor({ state: "visible", timeout: 5_000 }); await updateBtn.click();
      const editToast = await detectToast(page, "Risk updated successfully");
      console.log(`[AuditLog] Edit: ${editToast.match ? "OK" : "FAIL"}`);
    } else { console.log("[AuditLog] Edit: SKIP — edit button not found"); }
    await page.waitForTimeout(2_000);

    // ── ACTION 4: Delete Risk ────────────────────────────────────────────
    console.log("[AuditLog] === ACTION 4: Delete Risk ===");
    await navigateTo(page, config.tableUrl);
    await page.waitForTimeout(1_500);
    await searchRisk(page, riskTitle);
    const riskRow = page.locator("text=" + riskTitle).first();
    try {
      await riskRow.waitFor({ state: "visible", timeout: 5_000 }); await riskRow.click();
      await page.waitForTimeout(1_500);
      const deleteBtn = page.locator('[data-testid^="button-delete-risk-"]').first();
      await deleteBtn.waitFor({ state: "visible", timeout: 5_000 }); await deleteBtn.click();
      const deleteToast = await detectToast(page, "Risk deleted successfully");
      console.log(`[AuditLog] Delete: ${deleteToast.match ? "OK" : "FAIL"}`);
    } catch { console.log("[AuditLog] Delete: SKIP — risk not found in table"); }
    await page.waitForTimeout(2_000);

    // ── ACTION 5: Send Chat Message ──────────────────────────────────────
    console.log("[AuditLog] === ACTION 5: Chat Message ===");
    await navigateTo(page, config.dashboardUrl);
    await page.waitForTimeout(1_500);
    const chatOk = await sendChatMessage(page, chatMsg);
    console.log(`[AuditLog] Chat: ${chatOk ? "OK" : "FAIL"}`);
    await page.waitForTimeout(2_000);

    // ── ACTION 6: Logout ─────────────────────────────────────────────────
    console.log("[AuditLog] === ACTION 6: Logout ===");
    const logoutOk = await performLogout(page);
    console.log(`[AuditLog] Logout: ${logoutOk ? "OK" : "FAIL"}`);

    // ── RE-LOGIN for audit verification ──────────────────────────────────
    console.log("[AuditLog] === RE-LOGIN for verification ===");
    invalidateSession();
    const reloginOk = await performLogin(page, input.username, input.password);
    if (!reloginOk) {
      result.status = "error"; result.message = "Re-login failed for audit verification";
      result.screenshots.failure = await captureFailure(context, "audit_relogin_fail"); return result;
    }
    await selectCompany(page, "demo");
    await page.waitForTimeout(2_000);

    // ── VERIFICATION PHASE ───────────────────────────────────────────────
    console.log("[AuditLog] === VERIFICATION PHASE ===");
    console.log("[AuditLog] Verifying: Login");
    result.steps.login = await verifyAuditEntry(page, "Login", "Login", "Session", "Info", input.username);
    console.log("[AuditLog] Verifying: Create");
    result.steps.create_risk = await verifyAuditEntry(page, "Create", "Create", "Risk", "Info", riskTitle);
    console.log("[AuditLog] Verifying: Update");
    result.steps.edit_risk = await verifyAuditEntry(page, "Update", "Update", "Risk", "Info", riskTitle);
    console.log("[AuditLog] Verifying: Delete");
    result.steps.delete_risk = await verifyAuditEntry(page, "Delete", "Delete", "Risk", "Warning", riskTitle);
    console.log("[AuditLog] Verifying: Message");
    result.steps.chat_message = await verifyAuditEntry(page, "Message", "Message", "Chat Message", "Info", "user message");
    console.log("[AuditLog] Verifying: Logout");
    result.steps.logout = await verifyAuditEntry(page, "Logout", "Logout", "Session", "Info", "User logged out");
    // ── CALCULATE RESULTS ────────────────────────────────────────────────
    const stepKeys = ["login", "create_risk", "edit_risk", "delete_risk", "chat_message", "logout"];
    const stepLabels = ["Login", "Create", "Update", "Delete", "Message", "Logout"];
    result.passed = stepKeys.filter(k => result.steps[k]?.status === "pass").length;
    result.failed = result.total_steps - result.passed;
    result.status = result.failed === 0 ? "pass" : "fail";
    result.steps_summary = stepLabels.map((label, i) => {
      const s = result.steps[stepKeys[i]];
      return `${label}:${s?.status === "pass" ? "✅" : "❌"}`;
    }).join(" ");
    result.message = result.steps_summary;
    if (result.failed > 0 && !result.screenshots.failure) result.screenshots.failure = await captureFailure(context, "audit_verification_fail");
    console.log(`[AuditLog] === RESULT: ${result.status.toUpperCase()} (${result.passed}/${result.total_steps}) ===`);
    console.log(`[AuditLog] ${result.steps_summary}`);
    return result;
  } catch (err) {
    result.screenshots.failure = await captureFailure(context, "audit_error");
    result.status = "error"; result.message = (err as Error).message;
    console.log(`[AuditLog] Error: ${result.message}`);
    return result;
  } finally { await safeClose(context); }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) { next(); return; }
  if (req.headers["x-api-key"] !== config.apiKey) { res.status(401).json({ status: "error", message: "Unauthorized" }); return; }
  next();
}

// ─── Queued + Timeout-Guarded Endpoints ──────────────────────────────────────

app.post("/create-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<RiskInput>;
  if (!input.username || !input.password || !input.title) { res.status(400).json({ status: "error", message: "Missing: username, password, title" }); return; }
  const full: RiskInput = { username: input.username, password: input.password, title: input.title, description: input.description || "", category: input.category || "Technical", status: input.status || "Open", impact: input.impact || "3 - Medium", likelihood: input.likelihood || "3 - Medium", owner: input.owner || "", dueDate: input.dueDate || "", potentialCost: input.potentialCost || "", mitigationPlan: input.mitigationPlan || "" };
  try {
    const result = await executionQueue.add(() => withTimeout(() => performCreateRisk(full), config.executionTimeout, "create-risk"));
    await saveTestResult("TC_Create_Risk", { status: result.status, username: result.username, risk_title: result.riskTitle, message: result.message, assertion_expected: result.assertion.expected, assertion_actual: result.assertion.actual, assertion_match: result.status === "success", screenshot_failure: result.screenshots?.failure || null }, { failure_type: result.message.includes("FAILED [") ? result.message.match(/FAILED \[(.+?)\]/)?.[1] || null : null, checks: { toast_confirmed: result.message.includes("Toast: ✓"), dashboard_visible: result.message.includes("Dashboard: ✓"), table_search: result.message.includes("Table: ✓"), fields_valid: result.message.includes("Fields: ✓") }, field_mismatches: result.message.includes("Fields: ✗") ? result.message : [], table_screenshot: result.screenshots?.table_issue || null });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Create_Risk", { status: "error", username: input.username!, risk_title: input.title, message: (err as Error).message, assertion_expected: "Risk created successfully", assertion_match: false });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/edit-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<EditRiskInput>;
  if (!input.username || !input.password || !input.searchTitle) { res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" }); return; }
  try {
    const result = await executionQueue.add(() => withTimeout(() => performEditRisk(input as EditRiskInput), config.executionTimeout, "edit-risk"));
    await saveTestResult("TC_Edit_Risk", { status: result.status, username: result.username, risk_title: result.riskTitle, message: result.message, assertion_expected: result.assertion.expected, assertion_actual: result.assertion.actual, assertion_match: result.assertion.match, screenshot_failure: result.screenshots?.failure || null }, { original_title: input.searchTitle, edited_title: result.riskTitle });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Edit_Risk", { status: "error", username: input.username!, risk_title: input.searchTitle, message: (err as Error).message, assertion_expected: "Risk updated successfully", assertion_match: false }, { original_title: input.searchTitle });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/delete-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<DeleteRiskInput>;
  if (!input.username || !input.password || !input.searchTitle) { res.status(400).json({ status: "error", message: "Missing: username, password, searchTitle" }); return; }
  try {
    const result = await executionQueue.add(() => withTimeout(() => performDeleteRisk(input as DeleteRiskInput), config.executionTimeout, "delete-risk"));
    await saveTestResult("TC_Delete_Risk", { status: result.status, username: result.username, risk_title: result.riskTitle, message: result.message, assertion_expected: result.assertion.expected, assertion_actual: result.assertion.actual, assertion_match: result.assertion.match, screenshot_failure: result.screenshots?.failure || null });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Delete_Risk", { status: "error", username: input.username!, risk_title: input.searchTitle, message: (err as Error).message, assertion_expected: "Risk deleted successfully", assertion_match: false });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/risk-status-workflow", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<StatusWorkflowInput>;
  if (!input.username || !input.password || !input.title) { res.status(400).json({ status: "error", message: "Missing: username, password, title" }); return; }
  const full: StatusWorkflowInput = { username: input.username, password: input.password, title: input.title, description: input.description || "Status workflow test risk", category: input.category || "Technical", impact: input.impact || "3 - Medium", likelihood: input.likelihood || "3 - Medium", owner: input.owner || "", dueDate: input.dueDate || "", potentialCost: input.potentialCost || "", mitigationPlan: input.mitigationPlan || "" };
  try {
    const result = await executionQueue.add(() => withTimeout(() => performStatusWorkflow(full), 180_000, "risk-status-workflow"));
    const stepMap: Record<string, string | null> = { create: null, in_review: null, mitigated: null, closed: null };
    for (const s of result.steps) {
      if (s.step === "create") stepMap.create = s.status;
      if (s.step === "update_in_review") stepMap.in_review = s.status;
      if (s.step === "update_mitigated") stepMap.mitigated = s.status;
      if (s.step === "update_closed") stepMap.closed = s.status;
    }
    await saveTestResult("TC_Status_Workflow", { status: result.status, username: input.username!, risk_title: result.riskTitle, message: result.message, assertion_expected: result.assertion.expected, assertion_actual: result.assertion.actual, assertion_match: result.assertion.match, screenshot_failure: result.screenshots?.failure || null }, { expected_flow: result.assertion.expected, actual_flow: result.assertion.actual, flow_match: result.assertion.match, versions_created: result.versions_created, step_create: stepMap.create, step_in_review: stepMap.in_review, step_mitigated: stepMap.mitigated, step_closed: stepMap.closed });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Status_Workflow", { status: "error", username: input.username!, risk_title: input.title, message: (err as Error).message, assertion_expected: "Open -> In Review -> Mitigated -> Closed", assertion_match: false }, { expected_flow: "Open -> In Review -> Mitigated -> Closed", actual_flow: null, flow_match: false });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/filter-risks", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<FilterRiskInput>;
  if (!input.username || !input.password) { res.status(400).json({ status: "error", message: "Missing: username, password" }); return; }
  try {
    const result = await executionQueue.add(() => withTimeout(() => performFilterRisks(input as FilterRiskInput), config.executionTimeout, "filter-risks"));
    await saveTestResult("tc_filter_risk", { status: result.status, username: input.username, filter_status: result.filters.status, filter_category: result.filters.category, assertion_expected: result.assertion.expected, assertion_actual: result.assertion.actual, assertion_match: result.assertion.match, total_rows: result.total_rows, mismatched_count: result.mismatched_rows.length, screenshot_failure: result.screenshots?.failure || null, message: result.assertion.actual });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("tc_filter_risk", { status: "error", username: input.username, filter_status: input.statusFilter || "All Status", filter_category: input.categoryFilter || "All", assertion_expected: "All rows match filters", assertion_actual: null, assertion_match: false, total_rows: 0, mismatched_count: 0, screenshot_failure: null, message: (err as Error).message });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/score-matrix", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<ScoreMatrixInput>;
  if (!input.username || !input.password || !input.impact || !input.likelihood || input.expectedScore === undefined) { res.status(400).json({ status: "error", message: "Missing: username, password, impact, likelihood, expectedScore" }); return; }
  try {
    const result = await executionQueue.add(() => withTimeout(() => performScoreMatrix(input as ScoreMatrixInput), config.executionTimeout, "score-matrix"));
    await saveTestResult("TC_Score_Matrix", { status: result.status, username: result.username, risk_title: result.risk_title, message: result.message, assertion_expected: "Risk created successfully", assertion_actual: result.status === "pass" ? "Risk created successfully" : result.message, assertion_match: result.status === "pass", screenshot_failure: result.screenshots?.failure || null }, { impact: result.impact, likelihood: result.likelihood, expected_score: result.expected_score, cleaned_up: result.cleaned_up });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Score_Matrix", { status: "error", username: input.username!, message: (err as Error).message, assertion_expected: "Risk created successfully", assertion_actual: (err as Error).message, assertion_match: false }, { impact: input.impact, likelihood: input.likelihood, expected_score: input.expectedScore });
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

app.post("/audit-log", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<AuditLogInput>;
  if (!input.username || !input.password) { res.status(400).json({ status: "error", message: "Missing: username, password" }); return; }
  try {
    const result = await executionQueue.add(() => withTimeout(() => performAuditLog(input as AuditLogInput), 300_000, "audit-log"));
    await saveTestResult("TC_Audit_Log", { status: result.status, username: result.username, risk_title: result.risk_title, message: result.steps_summary || result.message, assertion_expected: `All ${result.total_steps} audit entries verified`, assertion_actual: `${result.passed} of ${result.total_steps} audit entries verified (${result.passed}/${result.total_steps})`, assertion_match: result.failed === 0, screenshot_failure: result.screenshots?.failure || null }, { total_steps: result.total_steps, passed: result.passed, failed: result.failed, steps: result.steps });
    res.status(result.status === "error" ? 500 : 200).json(result);
  } catch (err) {
    await saveTestResult("TC_Audit_Log", { status: "error", username: input.username!, message: (err as Error).message, assertion_expected: "All 6 audit entries verified", assertion_match: false }, {});
    res.status(500).json({ status: "error", message: (err as Error).message });
  }
});

// ─── Reset Browser ───────────────────────────────────────────────────────────

app.post("/reset-browser", authMiddleware, async (_req: Request, res: Response) => {
  await closeBrowser();
  invalidateSession();
  if (global.gc) { global.gc(); console.log("[Reset] Forced garbage collection"); }
  res.json({ status: "ok", message: "Browser closed, session cleared, memory released", timestamp: new Date().toISOString() });
});

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: "running",
    service: "captus-risk-bot",
    endpoints: [
      "/create-risk", "/edit-risk", "/delete-risk",
      "/risk-status-workflow", "/filter-risks", "/score-matrix",
      "/audit-log", "/reset-browser",
    ],
    browserConnected: browserInstance?.isConnected() ?? false,
    sessionCached: cachedSession ? cachedSession.username : null,
    queue: { running: executionQueue.isRunning, pending: executionQueue.pendingCount },
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Start & Shutdown ────────────────────────────────────────────────────────

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Risk Bot running on port ${config.port}`);
  console.log(`Dashboard: ${config.dashboardUrl}`);
  console.log(`Table:     ${config.tableUrl}`);
  console.log(`Audit:     ${config.auditUrl}`);
  console.log(`Screenshots: ${config.supabaseUrl ? "ENABLED" : "DISABLED"}`);
  console.log(`Auth:        ${config.apiKey ? "ENABLED" : "DISABLED"}`);
  console.log(`Queue:       ENABLED (single concurrency)`);
  console.log(`Timeout:     ${config.executionTimeout / 1000}s per test`);
  console.log(`Resources:   Blocking images, fonts, media, trackers`);
  console.log(`Sessions:    Reuse enabled (${SESSION_TTL / 1000}s TTL)`);
});

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
