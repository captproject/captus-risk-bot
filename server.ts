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

interface RiskResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
  riskTitle: string;
  screenshots: {
    form_filled: string | null;
    success_message: string | null;
    risk_in_table: string | null;
  };
}

interface Config {
  loginUrl: string;
  dashboardUrl: string;
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

async function uploadScreenshot(
  buffer: Buffer,
  label: string
): Promise<string | null> {
  if (!config.supabaseUrl || !config.supabaseKey) {
    return null;
  }

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

// ─── Helper: Fill Text Input using getByTestId ───────────────────────────────

async function fillInput(page: Page, testId: string, value: string): Promise<void> {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: "visible", timeout: 10000 });
  await locator.clear();
  await locator.fill(value);
}

// ─── Helper: Select Dropdown Option (Radix UI) using getByTestId ─────────────

async function selectDropdown(page: Page, triggerTestId: string, optionText: string): Promise<void> {
  // Click dropdown trigger using built-in locator
  const trigger = page.getByTestId(triggerTestId);
  await trigger.waitFor({ state: "visible", timeout: 10000 });
  await trigger.click();

  // Wait for dropdown to open
  await page.waitForTimeout(500);

  // Click the matching option using getByRole + text filter
  const option = page.getByRole("option", { name: optionText });
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  // Wait for dropdown to close
  await page.waitForTimeout(300);
}

// ─── Helper: Set Due Date using getByTestId ──────────────────────────────────

async function setDueDate(page: Page, dateString: string): Promise<void> {
  // Click date picker button
  const dateButton = page.getByTestId("button-risk-due-date");
  await dateButton.waitFor({ state: "visible", timeout: 10000 });
  await dateButton.click();

  // Wait for calendar to open
  await page.waitForTimeout(500);

  // Parse target date
  const targetDate = new Date(dateString);
  const targetDay = targetDate.getDate().toString();

  // Navigate months if needed
  const targetMonth = targetDate.toLocaleString("en-US", { month: "long" });
  const targetYear = targetDate.getFullYear().toString();
  const targetMonthYear = `${targetMonth} ${targetYear}`;

  // Check current calendar month and navigate forward if needed
  for (let i = 0; i < 12; i++) {
    const calendarHeading = page.locator('[role="heading"]').filter({ hasText: /\w+ \d{4}/ });
    const currentMonthText = await calendarHeading.textContent().catch(() => "");

    if (currentMonthText?.includes(targetMonthYear)) {
      break;
    }

    // Click next month button
    const nextButton = page.getByRole("button", { name: /next month|chevron/i });
    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click();
      await page.waitForTimeout(300);
    } else {
      // Fallback: try aria-label based navigation
      const navNext = page.locator('button[name="next-month"], button[aria-label="Go to next month"]');
      if (await navNext.isVisible().catch(() => false)) {
        await navNext.click();
        await page.waitForTimeout(300);
      } else {
        break;
      }
    }
  }

  // Click the target day using getByRole gridcell
  const dayCell = page.getByRole("gridcell", { name: targetDay, exact: true });
  const dayButton = dayCell.locator("button").first();

  if (await dayButton.isVisible().catch(() => false)) {
    await dayButton.click();
  } else {
    // Fallback: click the gridcell directly
    await dayCell.click();
  }

  await page.waitForTimeout(300);
}

// ─── Core Login Logic using Built-in Locators ────────────────────────────────

async function performLogin(page: Page, username: string, password: string): Promise<boolean> {
  try {
    await page.goto(config.loginUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });

    // Wait for email field using getByTestId
    const emailField = page.getByTestId("input-email");
    await emailField.waitFor({ state: "visible", timeout: 15000 });

    // Wait for React hydration
    await page.waitForTimeout(3000);

    // Fill email
    await emailField.clear();
    await emailField.fill(username);

    // Fill password
    const passwordField = page.getByTestId("input-password");
    await passwordField.waitFor({ state: "visible", timeout: 5000 });
    await passwordField.clear();
    await passwordField.fill(password);

    // Click login button
    const loginButton = page.getByTestId("button-login");
    await loginButton.waitFor({ state: "visible", timeout: 5000 });
    await loginButton.click();

    // Wait for navigation
    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    return !currentUrl.includes("/login");
  } catch (err) {
    console.error(`Login error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Core Risk Creation Logic using Built-in Locators ────────────────────────

async function performCreateRisk(input: RiskInput): Promise<RiskResult> {
  let context: BrowserContext | null = null;

  const result: RiskResult = {
    status: "error",
    message: "",
    username: input.username,
    riskTitle: input.title,
    screenshots: {
      form_filled: null,
      success_message: null,
      risk_in_table: null,
    },
  };

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    context.setDefaultTimeout(config.navigationTimeout);

    const page: Page = await context.newPage();

    // ── Step 0: Login ──────────────────────────────────────────────────────

    console.log(`[Risk] Logging in as ${input.username}...`);
    const loginSuccess = await performLogin(page, input.username, input.password);

    if (!loginSuccess) {
      result.status = "failed";
      result.message = "Login failed — could not authenticate";
      const screenshot = await page.screenshot({ fullPage: true });
      result.screenshots.form_filled = await uploadScreenshot(screenshot, "login_failed");
      await context.close();
      return result;
    }

    console.log("[Risk] Login successful");

    // ── Step 1: Navigate to Dashboard ──────────────────────────────────────

    console.log("[Risk] Navigating to dashboard...");
    await page.goto(config.dashboardUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });
    await page.waitForTimeout(3000);

    // ── Step 2: Click "Add Risk" button ────────────────────────────────────

    console.log("[Risk] Clicking Add Risk button...");
    const addRiskBtn = page.getByTestId("button-add-risk");
    await addRiskBtn.waitFor({ state: "visible", timeout: 10000 });
    await addRiskBtn.click();
    await page.waitForTimeout(2000);

    // ── Step 3: Fill Title ─────────────────────────────────────────────────

    console.log("[Risk] Filling title...");
    await fillInput(page, "input-risk-title", input.title);
    await page.waitForTimeout(300);

    // ── Step 4: Fill Description ───────────────────────────────────────────

    console.log("[Risk] Filling description...");
    await fillInput(page, "input-risk-description", input.description);
    await page.waitForTimeout(300);

    // ── Step 5: Select Category ────────────────────────────────────────────

    console.log(`[Risk] Selecting category: ${input.category}...`);
    await selectDropdown(page, "select-risk-category", input.category);

    // ── Step 6: Select Status ──────────────────────────────────────────────

    console.log(`[Risk] Selecting status: ${input.status}...`);
    await selectDropdown(page, "select-risk-status", input.status);

    // ── Step 7: Select Impact ──────────────────────────────────────────────

    console.log(`[Risk] Selecting impact: ${input.impact}...`);
    await selectDropdown(page, "select-risk-impact", input.impact);

    // ── Step 8: Select Likelihood ──────────────────────────────────────────

    console.log(`[Risk] Selecting likelihood: ${input.likelihood}...`);
    await selectDropdown(page, "select-risk-likelihood", input.likelihood);

    // ── Step 9: Fill Owner ─────────────────────────────────────────────────

    console.log(`[Risk] Filling owner: ${input.owner}...`);
    await fillInput(page, "input-risk-owner", input.owner);
    await page.waitForTimeout(300);

    // ── Step 10: Set Due Date ──────────────────────────────────────────────

    if (input.dueDate) {
      console.log(`[Risk] Setting due date: ${input.dueDate}...`);
      await setDueDate(page, input.dueDate);
    }

    // ── Step 11: Fill Potential Cost ───────────────────────────────────────

    console.log(`[Risk] Filling potential cost: ${input.potentialCost}...`);
    await fillInput(page, "input-risk-potential-cost", input.potentialCost);
    await page.waitForTimeout(300);

    // ── Step 12: Fill Mitigation Plan ──────────────────────────────────────

    console.log(`[Risk] Filling mitigation plan...`);
    await fillInput(page, "input-risk-mitigation", input.mitigationPlan);
    await page.waitForTimeout(300);

    // ── Step 13: Click "Create Risk" ───────────────────────────────────────

    console.log("[Risk] Clicking Create Risk button...");
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5000 });
    await saveBtn.click();

    // ── Step 14: Wait for and validate success message ─────────────────────

    console.log("[Risk] Waiting for success message...");
    await page.waitForTimeout(3000);

    // Try to find the success toast using getByText
    const successToast = page.getByText("Risk created successfully");
    let successDetected = await successToast.isVisible().catch(() => false);

    // Fallback: check full page text
    if (!successDetected) {
      const bodyText = await page.locator("body").innerText();
      successDetected = bodyText.toLowerCase().includes("risk created successfully");
    }

    if (!successDetected) {
      // FAILURE — capture screenshot of the failed state
      console.log("[Risk] FAILED — success message not found");
      const failScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.form_filled = await uploadScreenshot(failScreenshot, "create_risk_failed");
      result.status = "failed";
      result.message = "Risk creation failed — success message not detected";
      await context.close();
      return result;
    }

    console.log("[Risk] Success message validated!");

    // ── Step 15: Wait for table to update and verify ───────────────────────

    await page.waitForTimeout(3000);

    const riskInTable = page.getByText(input.title);
    const riskVisible = await riskInTable.isVisible().catch(() => false);

    if (riskVisible) {
      result.status = "success";
      result.message = "Risk created successfully and visible in table";
      console.log("[Risk] Risk confirmed in table!");
    } else {
      // Risk not in table — capture screenshot for debugging
      const tableFailScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.risk_in_table = await uploadScreenshot(tableFailScreenshot, "risk_not_in_table");
      result.status = "success";
      result.message = "Risk created successfully — toast confirmed, but risk not visible in table yet";
      console.log("[Risk] Toast confirmed, risk not yet visible in table");
    }

    await context.close();
    context = null;

    return result;
  } catch (error) {
    if (context) {
      // Capture error screenshot before closing
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          const errorScreenshot = await pages[0].screenshot({ fullPage: true });
          result.screenshots.form_filled = await uploadScreenshot(errorScreenshot, "error_state");
        }
      } catch {
        // Ignore screenshot error
      }
      await context.close().catch(() => {});
    }
    result.status = "error";
    result.message = (error as Error).message;
    return result;
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: "1mb" }));

// Auth middleware
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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

// Create risk endpoint
app.post("/create-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<RiskInput>;

  if (!input.username || !input.password || !input.title) {
    res.status(400).json({
      status: "error",
      message: "Missing required fields: username, password, title",
    });
    return;
  }

  const fullInput: RiskInput = {
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

  const result = await performCreateRisk(fullInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "running",
    service: "captus-risk-bot",
    browserConnected: browserInstance?.isConnected() ?? false,
    timestamp: new Date().toISOString(),
  });
});

// ─── Start & Graceful Shutdown ───────────────────────────────────────────────

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Risk Bot running on port ${config.port}`);
  console.log(`Target: ${config.dashboardUrl}`);
  console.log(`Screenshots: ${config.supabaseUrl ? "ENABLED" : "DISABLED"}`);
  console.log(`Auth: ${config.apiKey ? "ENABLED" : "DISABLED"}`);
});

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
