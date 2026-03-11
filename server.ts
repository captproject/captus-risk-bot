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
  await page.waitForTimeout(1000);

  // Parse target date — expects yyyy-MM-dd format
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

  // Navigate to correct month — max 12 attempts to prevent infinite loop
  for (let i = 0; i < 12; i++) {
    // Check current calendar heading
    const headingText = await page.evaluate(() => {
      // Primary: react-day-picker heading
      const rdp = document.querySelector('[id^="react-day-picker"]');
      if (rdp && rdp.textContent?.trim()) {
        return rdp.textContent.trim();
      }
      // Fallback: any element with role="presentation" that looks like a month
      const presentations = document.querySelectorAll('[role="presentation"]');
      for (const el of presentations) {
        const text = el.textContent?.trim() || "";
        if (/[A-Z][a-z]+ \d{4}/.test(text)) {
          return text;
        }
      }
      return "";
    });

    console.log(`[Risk] Current calendar month: ${headingText}`);

    if (headingText.includes(targetMonthYear)) {
      console.log("[Risk] Correct month found");
      break;
    }

    // Click next month button — try react-day-picker selectors first
    const clicked = await page.evaluate(() => {
      // Primary: react-day-picker next button
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
        if (btn) {
          btn.click();
          return true;
        }
      }
      // Fallback: find any nav button with right chevron
      const allButtons = document.querySelectorAll('button');
      for (const btn of allButtons) {
        const label = btn.getAttribute('aria-label') || '';
        if (label.toLowerCase().includes('next')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      console.log("[Risk] Could not find next month button — stopping navigation");
      break;
    }

    await page.waitForTimeout(500);
  }

  // Click the target day
  console.log(`[Risk] Clicking day: ${targetDay}`);
  await page.evaluate((day) => {
    // Find all day buttons in the calendar
    const cells = document.querySelectorAll('[role="gridcell"]');
    for (const cell of cells) {
      const button = cell.querySelector("button");
      const textEl = button || cell;
      const text = textEl.textContent?.trim();

      if (text === day) {
        // Skip disabled or outside-month days
        const isDisabled = button?.hasAttribute("disabled") ||
          cell.classList.toString().includes("outside") ||
          cell.getAttribute("aria-disabled") === "true";

        if (!isDisabled) {
          (button || cell as HTMLElement).click();
          console.log(`Clicked day: ${day}`);
          return;
        }
      }
    }
  }, targetDay);

  await page.waitForTimeout(500);
  console.log("[Risk] Due date set");
}

// ─── Core Login Logic using Built-in Locators ────────────────────────────────

async function performLogin(page: Page, username: string, password: string): Promise<boolean> {
  try {
    await page.goto(config.loginUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });

    // Wait for email field
    await page.waitForSelector('input[name="email"]', {
      state: "visible",
      timeout: 15000,
    });

    // Wait for React hydration
    await page.waitForTimeout(5000);

    // Fill email using React's native value setter (proven method from login bot)
    await page.evaluate((email) => {
      const input = document.querySelector('input[name="email"]') as HTMLInputElement;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (setter) setter.call(input, email);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, username);

    // Fill password using React's native value setter
    await page.evaluate((pass) => {
      const input = document.querySelector('input[name="password"]') as HTMLInputElement;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (setter) setter.call(input, pass);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, password);

    // Click login button via evaluate
    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="button-login"]') as HTMLButtonElement;
      if (btn) btn.click();
    });

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
