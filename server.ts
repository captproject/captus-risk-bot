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

interface RiskResult {
  status: "success" | "failed" | "error";
  message: string;
  username: string;
  riskTitle: string;
  screenshots: {
    failure?: string | null;
    table_issue?: string | null;
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
        if (setter) {
          setter.call(input, val);
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { testId, val: value }
  );
}

// ─── Helper: Select Dropdown Option (Radix UI) ──────────────────────────────

async function selectDropdown(page: Page, triggerTestId: string, optionText: string): Promise<void> {
  const trigger = page.getByTestId(triggerTestId);
  await trigger.waitFor({ state: "visible", timeout: 10000 });
  await trigger.click();

  await page.waitForTimeout(500);

  const option = page.getByRole("option", { name: optionText });
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  await page.waitForTimeout(300);
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
      if (rdp && rdp.textContent?.trim()) {
        return rdp.textContent.trim();
      }
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
        if (btn) {
          btn.click();
          return true;
        }
      }
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

  console.log(`[Risk] Clicking day: ${targetDay}`);
  await page.evaluate((day) => {
    const cells = document.querySelectorAll('[role="gridcell"]');
    for (const cell of cells) {
      const button = cell.querySelector("button");
      const textEl = button || cell;
      const text = textEl.textContent?.trim();

      if (text === day) {
        const isDisabled = button?.hasAttribute("disabled") ||
          cell.classList.toString().includes("outside") ||
          cell.getAttribute("aria-disabled") === "true";

        if (!isDisabled) {
          (button || cell as HTMLElement).click();
          return;
        }
      }
    }
  }, targetDay);

  await page.waitForTimeout(500);
  console.log("[Risk] Due date set");
}

// ─── Helper: Search for Risk by Title ────────────────────────────────────────

async function searchRisk(page: Page, title: string): Promise<void> {
  console.log(`[Risk] Searching for: ${title}`);

  // Clear and fill search bar using React native setter
  await page.evaluate(
    (searchText) => {
      const input = document.querySelector('[data-testid="input-search-risks"]') as HTMLInputElement;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        if (setter) setter.call(input, searchText);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    title
  );

  // Wait for search results to filter
  await page.waitForTimeout(2000);
  console.log("[Risk] Search completed");
}

// ─── Helper: Detect Toast Message ────────────────────────────────────────────

async function detectToast(page: Page, expectedText: string): Promise<boolean> {
  console.log(`[Risk] Watching for toast: "${expectedText}"...`);

  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);

    const found = await page.evaluate((text) => {
      const body = document.body.innerText.toLowerCase();
      return body.includes(text.toLowerCase());
    }, expectedText);

    if (found) {
      console.log(`[Risk] Toast detected after ${(i + 1) * 500}ms`);
      return true;
    }
  }

  console.log("[Risk] Toast not detected within 5 seconds");
  return false;
}

// ─── Core Login Logic ────────────────────────────────────────────────────────

async function performLogin(page: Page, username: string, password: string): Promise<boolean> {
  try {
    await page.goto(config.loginUrl, {
      waitUntil: "networkidle",
      timeout: config.navigationTimeout,
    });

    await page.waitForSelector('input[name="email"]', {
      state: "visible",
      timeout: 15000,
    });

    await page.waitForTimeout(5000);

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

    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="button-login"]') as HTMLButtonElement;
      if (btn) btn.click();
    });

    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    return !currentUrl.includes("/login");
  } catch (err) {
    console.error(`Login error: ${(err as Error).message}`);
    return false;
  }
}

// ─── Helper: Fill Risk Form (used by Create and Edit) ────────────────────────

async function fillRiskForm(page: Page, data: {
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
}): Promise<void> {

  if (data.title) {
    console.log(`[Risk] Filling title: ${data.title}`);
    // Clear existing value first
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-title"]') as HTMLInputElement;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, '');
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await fillInput(page, "input-risk-title", data.title);
    await page.waitForTimeout(300);
  }

  if (data.description) {
    console.log(`[Risk] Filling description`);
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-description"]') as HTMLTextAreaElement;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(input, '');
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
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
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, '');
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
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
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, '');
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await fillInput(page, "input-risk-potential-cost", data.potentialCost);
    await page.waitForTimeout(300);
  }

  if (data.mitigationPlan) {
    console.log(`[Risk] Filling mitigation plan`);
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="input-risk-mitigation"]') as HTMLTextAreaElement;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(input, '');
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await fillInput(page, "input-risk-mitigation", data.mitigationPlan);
    await page.waitForTimeout(300);
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
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page: Page = await context.newPage();

    // Login
    console.log(`[Create] Logging in as ${input.username}...`);
    const loginSuccess = await performLogin(page, input.username, input.password);
    if (!loginSuccess) {
      result.status = "failed";
      result.message = "Login failed — could not authenticate";
      const screenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(screenshot, "create_login_failed");
      await context.close();
      return result;
    }
    console.log("[Create] Login successful");

    // Navigate to dashboard
    console.log("[Create] Navigating to dashboard...");
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(3000);

    // Click Add Risk
    console.log("[Create] Clicking Add Risk...");
    const addRiskBtn = page.getByTestId("button-add-risk");
    await addRiskBtn.waitFor({ state: "visible", timeout: 10000 });
    await addRiskBtn.click();
    await page.waitForTimeout(2000);

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

    // Click Create Risk
    console.log("[Create] Clicking Create Risk...");
    const saveBtn = page.getByTestId("button-save-risk");
    await saveBtn.waitFor({ state: "visible", timeout: 5000 });
    await saveBtn.click();

    // Detect toast
    let successDetected = await detectToast(page, "Risk created successfully");

    // Fallback: check table
    if (!successDetected) {
      console.log("[Create] Toast missed — checking table...");
      await page.waitForTimeout(2000);
      successDetected = await page.evaluate((title) => document.body.innerText.includes(title), input.title);
    }

    if (!successDetected) {
      const failScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(failScreenshot, "create_failed");
      result.status = "failed";
      result.message = "Risk creation failed — success message not detected and risk not found in table";
      await context.close();
      return result;
    }

    result.status = "success";
    result.message = "Risk created successfully";
    console.log("[Create] Risk created successfully!");

    await context.close();
    return result;
  } catch (error) {
    if (context) {
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          const errShot = await pages[0].screenshot({ fullPage: true });
          result.screenshots.failure = await uploadScreenshot(errShot, "create_error");
        }
      } catch { /* ignore */ }
      await context.close().catch(() => {});
    }
    result.status = "error";
    result.message = (error as Error).message;
    return result;
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
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page: Page = await context.newPage();

    // Login
    console.log(`[Edit] Logging in as ${input.username}...`);
    const loginSuccess = await performLogin(page, input.username, input.password);
    if (!loginSuccess) {
      result.status = "failed";
      result.message = "Login failed — could not authenticate";
      const screenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(screenshot, "edit_login_failed");
      await context.close();
      return result;
    }
    console.log("[Edit] Login successful");

    // Navigate to dashboard
    console.log("[Edit] Navigating to dashboard...");
    await page.goto(config.dashboardUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(3000);

    // Search for risk
    await searchRisk(page, input.searchTitle);

    // Find and click the edit button for this risk
    console.log("[Edit] Looking for edit button...");
    const editButton = await page.evaluate((title) => {
      // Find the risk row containing the title
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if (el.textContent?.trim() === title && el.children.length === 0) {
          // Found the title element — now find the edit button in the same row area
          const row = el.closest('[class*="card"], [class*="row"], tr, [class*="risk"]') || el.parentElement?.parentElement?.parentElement;
          if (row) {
            const editBtn = row.querySelector('[data-testid^="button-edit-heatmap-risk-"]') as HTMLButtonElement;
            if (editBtn) {
              editBtn.click();
              return true;
            }
          }
        }
      }
      // Fallback: click any visible edit button (when search returns single result)
      const editBtns = document.querySelectorAll('[data-testid^="button-edit-heatmap-risk-"]');
      if (editBtns.length === 1) {
        (editBtns[0] as HTMLButtonElement).click();
        return true;
      }
      return false;
    }, input.searchTitle);

    if (!editButton) {
      const failScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(failScreenshot, "edit_button_not_found");
      result.status = "failed";
      result.message = `Edit button not found for risk: ${input.searchTitle}`;
      await context.close();
      return result;
    }

    console.log("[Edit] Edit modal opening...");
    await page.waitForTimeout(2000);

    // Fill only the fields that need to be updated
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

    // Click Update Risk
    console.log("[Edit] Clicking Update Risk...");
    const updateBtn = page.getByTestId("button-save-risk");
    await updateBtn.waitFor({ state: "visible", timeout: 5000 });
    await updateBtn.click();

    // Detect toast
    let successDetected = await detectToast(page, "Risk updated successfully");

    // Fallback: check for updated title in table
    if (!successDetected && input.newTitle) {
      console.log("[Edit] Toast missed — checking table for updated title...");
      await page.waitForTimeout(2000);
      successDetected = await page.evaluate((title) => document.body.innerText.includes(title), input.newTitle);
    }

    if (!successDetected) {
      const failScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(failScreenshot, "edit_failed");
      result.status = "failed";
      result.message = "Risk update failed — success message not detected";
      await context.close();
      return result;
    }

    result.status = "success";
    result.message = "Risk updated successfully";
    result.riskTitle = input.newTitle || input.searchTitle;
    console.log("[Edit] Risk updated successfully!");

    await context.close();
    return result;
  } catch (error) {
    if (context) {
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          const errShot = await pages[0].screenshot({ fullPage: true });
          result.screenshots.failure = await uploadScreenshot(errShot, "edit_error");
        }
      } catch { /* ignore */ }
      await context.close().catch(() => {});
    }
    result.status = "error";
    result.message = (error as Error).message;
    return result;
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
    screenshots: {},
  };

  try {
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(config.navigationTimeout);
    const page: Page = await context.newPage();

    // Login
    console.log(`[Delete] Logging in as ${input.username}...`);
    const loginSuccess = await performLogin(page, input.username, input.password);
    if (!loginSuccess) {
      result.status = "failed";
      result.message = "Login failed — could not authenticate";
      const screenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(screenshot, "delete_login_failed");
      await context.close();
      return result;
    }
    console.log("[Delete] Login successful");

    // Navigate to /table page
    console.log("[Delete] Navigating to table page...");
    await page.goto(config.tableUrl, { waitUntil: "networkidle", timeout: config.navigationTimeout });
    await page.waitForTimeout(3000);

    // Search for risk
    await searchRisk(page, input.searchTitle);

    // Click on risk title to expand the row
    console.log("[Delete] Expanding risk row...");
    const expanded = await page.evaluate((title) => {
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent?.trim();
        if (text === title && el.children.length === 0) {
          (el as HTMLElement).click();
          return true;
        }
      }
      // Fallback: click any element containing the title
      for (const el of allElements) {
        if (el.textContent?.includes(title) && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          const isSmall = (el as HTMLElement).offsetHeight < 100;
          if (isSmall) {
            (el as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }, input.searchTitle);

    if (!expanded) {
      const failScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(failScreenshot, "delete_risk_not_found");
      result.status = "failed";
      result.message = `Risk not found in table: ${input.searchTitle}`;
      await context.close();
      return result;
    }

    await page.waitForTimeout(2000);

    // Click Delete button
    console.log("[Delete] Clicking Delete button...");
    const deleteClicked = await page.evaluate(() => {
      const deleteBtns = document.querySelectorAll('[data-testid^="button-delete-risk-"]');
      if (deleteBtns.length > 0) {
        (deleteBtns[0] as HTMLButtonElement).click();
        return true;
      }
      return false;
    });

    if (!deleteClicked) {
      const failScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(failScreenshot, "delete_button_not_found");
      result.status = "failed";
      result.message = "Delete button not found after expanding risk row";
      await context.close();
      return result;
    }

    // Detect toast
    let successDetected = await detectToast(page, "Risk deleted successfully");

    // Fallback: verify risk is gone from the table
    if (!successDetected) {
      console.log("[Delete] Toast missed — verifying risk is removed...");
      await page.waitForTimeout(2000);

      // Search again — risk should not appear
      await searchRisk(page, input.searchTitle);
      const stillExists = await page.evaluate((title) => document.body.innerText.includes(title), input.searchTitle);
      if (!stillExists) {
        successDetected = true;
        console.log("[Delete] Risk confirmed removed from table");
      }
    }

    if (!successDetected) {
      const failScreenshot = await page.screenshot({ fullPage: true });
      result.screenshots.failure = await uploadScreenshot(failScreenshot, "delete_failed");
      result.status = "failed";
      result.message = "Risk deletion failed — success message not detected and risk still in table";
      await context.close();
      return result;
    }

    result.status = "success";
    result.message = "Risk deleted successfully";
    console.log("[Delete] Risk deleted successfully!");

    await context.close();
    return result;
  } catch (error) {
    if (context) {
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          const errShot = await pages[0].screenshot({ fullPage: true });
          result.screenshots.failure = await uploadScreenshot(errShot, "delete_error");
        }
      } catch { /* ignore */ }
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

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) { next(); return; }
  if (req.headers["x-api-key"] !== config.apiKey) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }
  next();
}

// Create Risk
app.post("/create-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<RiskInput>;

  if (!input.username || !input.password || !input.title) {
    res.status(400).json({ status: "error", message: "Missing required fields: username, password, title" });
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

// Edit Risk
app.post("/edit-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<EditRiskInput>;

  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing required fields: username, password, searchTitle" });
    return;
  }

  const result = await performEditRisk(input as EditRiskInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

// Delete Risk
app.post("/delete-risk", authMiddleware, async (req: Request, res: Response) => {
  const input = req.body as Partial<DeleteRiskInput>;

  if (!input.username || !input.password || !input.searchTitle) {
    res.status(400).json({ status: "error", message: "Missing required fields: username, password, searchTitle" });
    return;
  }

  const result = await performDeleteRisk(input as DeleteRiskInput);
  res.status(result.status === "error" ? 500 : 200).json(result);
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "running",
    service: "captus-risk-bot",
    endpoints: ["/create-risk", "/edit-risk", "/delete-risk"],
    browserConnected: browserInstance?.isConnected() ?? false,
    timestamp: new Date().toISOString(),
  });
});

// ─── Start & Graceful Shutdown ───────────────────────────────────────────────

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Risk Bot running on port ${config.port}`);
  console.log(`Dashboard: ${config.dashboardUrl}`);
  console.log(`Table: ${config.tableUrl}`);
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
