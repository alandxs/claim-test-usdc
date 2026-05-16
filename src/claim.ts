import readline from "node:readline";
import path from "node:path";
import { chromium as playwrightChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page } from "playwright";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SOLANA_RPC_URL, USDC_MINT } from "./config.js";
import {
  loadAccounts,
  loadProgress,
  type StoredAccount,
  updateProgress,
} from "./storage.js";

// 启用 stealth 反指纹检测，让 reCAPTCHA 大概率直接给"低风险绿勾"
playwrightChromium.use(StealthPlugin());

// ===== 配置 =====
const FAUCET_URL = "https://faucet.circle.com/";
const GRAPHQL_PATH = "/api/graphql";

// 单次"等响应"心跳间隔，可通过 CLAIM_TIMEOUT_MS 覆盖
const PER_REQUEST_TIMEOUT_MS =
  Number.parseInt(process.env.CLAIM_TIMEOUT_MS ?? "", 10) || 30 * 60_000;

// 链上确认 USDC 到账的最长等待时间 / 轮询间隔
const ONCHAIN_CONFIRM_TIMEOUT_MS =
  Number.parseInt(process.env.CLAIM_ONCHAIN_CONFIRM_MS ?? "", 10) || 90_000;
const ONCHAIN_POLL_INTERVAL_MS = 3_000;

// 等 reCAPTCHA 自动通过的时间（绿勾出现），超时则视作"挑战弹出"
const RECAPTCHA_AUTO_TIMEOUT_MS =
  Number.parseInt(process.env.RECAPTCHA_AUTO_TIMEOUT_MS ?? "", 10) || 15_000;

// 浏览器持久化 profile 路径（让 reCAPTCHA 信任度更高）
const BROWSER_PROFILE_DIR = path.resolve(
  process.cwd(),
  process.env.BROWSER_PROFILE_DIR ?? ".browser-profile",
);

// ===== stdin 控制：s = 跳过当前；q = 处理完当前后退出 =====
let skipResolver: (() => void) | null = null;
let quitRequested = false;
function setupStdin() {
  if (!process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === "s" || cmd === "skip") {
      console.log(">>> 收到跳过指令");
      skipResolver?.();
    } else if (cmd === "q" || cmd === "quit") {
      console.log(">>> 收到退出指令，处理完当前账户后退出");
      quitRequested = true;
      skipResolver?.();
    }
  });
}
function waitForSkip(): Promise<void> {
  return new Promise((resolve) => {
    skipResolver = resolve;
  });
}

// ===== 链上工具 =====
async function fetchAllOnChainUsdc(
  connection: Connection,
  accounts: StoredAccount[],
): Promise<bigint[]> {
  const BATCH = 100;
  const ataPks = accounts.map((a) =>
    getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(a.publicKey)),
  );
  const out: bigint[] = new Array(accounts.length).fill(0n);
  for (let i = 0; i < ataPks.length; i += BATCH) {
    const slice = ataPks.slice(i, i + BATCH);
    const infos = await connection.getMultipleAccountsInfo(slice, "confirmed");
    for (let j = 0; j < slice.length; j++) {
      const info = infos[j];
      if (info && info.data && (info.data as Buffer).length >= ACCOUNT_SIZE) {
        const parsed = AccountLayout.decode(
          (info.data as Buffer).subarray(0, ACCOUNT_SIZE),
        );
        out[i + j] = parsed.amount;
      }
    }
  }
  return out;
}

async function waitForOnChainReceipt(
  connection: Connection,
  ownerStr: string,
): Promise<bigint> {
  const owner = new PublicKey(ownerStr);
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
  const deadline = Date.now() + ONCHAIN_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const info = await connection.getAccountInfo(ata, "confirmed");
      if (info && info.data && (info.data as Buffer).length >= ACCOUNT_SIZE) {
        const parsed = AccountLayout.decode(
          (info.data as Buffer).subarray(0, ACCOUNT_SIZE),
        );
        if (parsed.amount > 0n) return parsed.amount;
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, ONCHAIN_POLL_INTERVAL_MS));
  }
  return 0n;
}

// ===== 浏览器辅助 =====
async function ensureNetworkAndToken(page: Page): Promise<void> {
  try {
    const usdcRadio = page.getByRole("radio", { name: "USDC" });
    const checked = await usdcRadio.isChecked({ timeout: 3_000 });
    if (!checked) await usdcRadio.check({ timeout: 5_000 });
  } catch {
    await page
      .getByRole("radio", { name: "USDC" })
      .check({ timeout: 5_000 })
      .catch(() => undefined);
  }

  const networkButton = page.getByRole("button", { name: /^Network/ });
  let needsSelect = true;
  try {
    const txt = (await networkButton.innerText({ timeout: 3_000 })) ?? "";
    if (/Solana\s*Devnet/i.test(txt)) needsSelect = false;
  } catch {
    needsSelect = true;
  }
  if (needsSelect) {
    await networkButton.click({ timeout: 8_000 });
    await page
      .getByRole("option", { name: "Solana Devnet" })
      .click({ timeout: 8_000 });
    await page.waitForTimeout(500);
  }
}

async function setupFaucetPage(page: Page) {
  await page.goto(FAUCET_URL, { waitUntil: "domcontentloaded" });
  await ensureNetworkAndToken(page);
  console.log("已自动选好 Network=Solana Devnet, Token=USDC");
}

// 模拟人类鼠标轨迹（贝塞尔曲线 + 抖动），降低 reCAPTCHA 行为风控
async function humanMouseMove(
  page: Page,
  toX: number,
  toY: number,
  steps = 25,
) {
  const from = await page.evaluate(() => ({
    x: window.innerWidth / 2 + Math.random() * 60 - 30,
    y: window.innerHeight / 2 + Math.random() * 60 - 30,
  }));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const jitterX = (Math.random() - 0.5) * 2;
    const jitterY = (Math.random() - 0.5) * 2;
    const x = from.x + (toX - from.x) * ease + jitterX;
    const y = from.y + (toY - from.y) * ease + jitterY;
    await page.mouse.move(x, y);
    await page.waitForTimeout(8 + Math.random() * 14);
  }
}

// 自动点 reCAPTCHA v2 复选框；返回值：
//  - "passed"：直接拿到绿勾
//  - "challenge"：弹了图片挑战，需要人工
//  - "no-recaptcha"：当前页面没有 reCAPTCHA（已经在 token 内或不需要）
async function tryClickRecaptcha(
  page: Page,
): Promise<"passed" | "challenge" | "no-recaptcha"> {
  const anchorFrameSelector =
    'iframe[src*="recaptcha"][src*="anchor"], iframe[title*="reCAPTCHA"]';
  const anchorElem = page.locator(anchorFrameSelector).first();
  let visible = false;
  try {
    visible = await anchorElem.isVisible({ timeout: 3_000 });
  } catch {
    visible = false;
  }
  if (!visible) return "no-recaptcha";

  // 鼠标走过去
  const box = await anchorElem.boundingBox();
  if (box) {
    await humanMouseMove(
      page,
      box.x + 28 + (Math.random() - 0.5) * 6,
      box.y + box.height / 2 + (Math.random() - 0.5) * 6,
    );
    await page.waitForTimeout(200 + Math.random() * 300);
  }

  // 点击复选框（iframe 内部）
  const checkboxFrame = page.frameLocator(anchorFrameSelector).first();
  try {
    await checkboxFrame
      .locator("#recaptcha-anchor")
      .click({ timeout: 5_000, force: true });
  } catch {
    // 兼容兜底：尝试 role
    try {
      await checkboxFrame
        .getByRole("checkbox")
        .click({ timeout: 3_000, force: true });
    } catch {
      return "challenge"; // 点不动当作弹挑战
    }
  }

  // 等结果
  const deadline = Date.now() + RECAPTCHA_AUTO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 检查是否拿到绿勾：#recaptcha-anchor 的 aria-checked=true
    try {
      const checked = await checkboxFrame
        .locator("#recaptcha-anchor")
        .getAttribute("aria-checked", { timeout: 2_000 });
      if (checked === "true") return "passed";
    } catch {
      // ignore
    }
    // 检查是否弹出图片挑战 iframe（bframe）
    try {
      const challengeVisible = await page
        .locator(
          'iframe[src*="recaptcha"][src*="bframe"], iframe[title*="recaptcha challenge"]',
        )
        .first()
        .isVisible({ timeout: 500 });
      if (challengeVisible) {
        // 还要进一步确认这个 challenge 框是显示的（有些时候它就 hidden）
        const bframeBox = await page
          .locator(
            'iframe[src*="recaptcha"][src*="bframe"], iframe[title*="recaptcha challenge"]',
          )
          .first()
          .boundingBox();
        if (bframeBox && bframeBox.width > 50 && bframeBox.height > 50) {
          return "challenge";
        }
      }
    } catch {
      // ignore
    }
    await page.waitForTimeout(500);
  }
  return "challenge";
}

// 自动点 "Send 20 USDC" 按钮
async function clickSendButton(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: /Send\s*20\s*USDC/i }),
    page.getByRole("button", { name: /^Send\b/i }),
    page.locator('button:has-text("Send")').last(),
  ];
  for (const btn of candidates) {
    try {
      if (await btn.isVisible({ timeout: 1_500 })) {
        const isEnabled = await btn.isEnabled({ timeout: 1_000 }).catch(() => true);
        if (!isEnabled) continue;
        await btn.click({ timeout: 3_000 });
        return true;
      }
    } catch {
      // try next
    }
  }
  return false;
}

interface ClaimOutcome {
  success: boolean;
  errorMessage?: string;
  attempts?: number;
  onChainAmount?: bigint;
}

async function claimOne(
  connection: Connection,
  page: Page,
  address: string,
): Promise<ClaimOutcome> {
  await ensureNetworkAndToken(page).catch(() => undefined);

  const addressBox = page.getByRole("textbox", { name: "Send to" });
  await addressBox.click();
  await addressBox.fill("");
  await addressBox.fill(address);
  await page.waitForTimeout(400 + Math.random() * 400);

  // 自动尝试点 reCAPTCHA 复选框
  const captchaResult = await tryClickRecaptcha(page).catch(
    () => "challenge" as const,
  );
  if (captchaResult === "challenge") {
    console.log(
      `>>> reCAPTCHA 弹出图片挑战，请手动解一下，然后脚本会自动点 Send`,
    );
  } else if (captchaResult === "passed") {
    console.log(`✓ reCAPTCHA 自动通过`);
  } else {
    console.log(`(当前页面未检测到 reCAPTCHA，可能 token 仍有效)`);
  }

  // 如果是 passed 或 no-recaptcha，直接自动点 Send；如果是 challenge，等 90s 期间
  // 用户解完挑战后 reCAPTCHA 状态会变 passed，我们也尝试自动点 Send。
  let autoSendDone = false;
  const sendDeadline =
    Date.now() + (captchaResult === "challenge" ? 90_000 : 5_000);
  while (!autoSendDone && Date.now() < sendDeadline) {
    // 如果当前还是 challenge 状态，等用户解
    if (captchaResult === "challenge") {
      const anchorFrame = page
        .frameLocator(
          'iframe[src*="recaptcha"][src*="anchor"], iframe[title*="reCAPTCHA"]',
        )
        .first();
      try {
        const checked = await anchorFrame
          .locator("#recaptcha-anchor")
          .getAttribute("aria-checked", { timeout: 1_500 });
        if (checked !== "true") {
          await page.waitForTimeout(800);
          continue;
        }
      } catch {
        await page.waitForTimeout(800);
        continue;
      }
    }
    autoSendDone = await clickSendButton(page);
    if (!autoSendDone) await page.waitForTimeout(500);
  }
  if (!autoSendDone) {
    console.log(
      `>>> 自动点击 Send 按钮失败，请手动点；想跳过：s + 回车`,
    );
  } else {
    console.log(`✓ 已自动点击 Send 按钮，等待响应...`);
  }

  let attempt = 0;
  while (true) {
    attempt++;
    const responsePromise = page
      .waitForResponse(
        (resp) =>
          resp.url().includes(GRAPHQL_PATH) &&
          resp.request().method() === "POST",
        { timeout: PER_REQUEST_TIMEOUT_MS },
      )
      .then(async (resp) => {
        let body: unknown = null;
        try {
          body = await resp.json();
        } catch {
          body = await resp.text().catch(() => null);
        }
        return { kind: "graphql" as const, status: resp.status(), body };
      });
    const skipPromise = waitForSkip().then(() => ({ kind: "skip" as const }));
    const winner = await Promise.race([responsePromise, skipPromise]).catch(
      (err) => ({ kind: "timeout" as const, error: (err as Error).message }),
    );
    skipResolver = null;

    if (winner.kind === "skip") {
      return { success: false, errorMessage: "user-skip", attempts: attempt };
    }
    if (winner.kind === "timeout") {
      console.log(
        `… ${PER_REQUEST_TIMEOUT_MS / 60_000} 分钟内未收到 Send 请求，继续等候（不算失败）`,
      );
      continue;
    }
    const { status, body } = winner;
    const bodyObj = body as
      | { data?: Record<string, unknown>; errors?: unknown[] }
      | null;
    const hasErrors =
      bodyObj && Array.isArray(bodyObj.errors) && bodyObj.errors.length > 0;
    const ok = status >= 200 && status < 300 && !!bodyObj?.data && !hasErrors;

    if (ok) {
      console.log(
        `… GraphQL 返回成功，校验链上是否真的到账（最多 ${
          ONCHAIN_CONFIRM_TIMEOUT_MS / 1000
        }s）...`,
      );
      const amount = await waitForOnChainReceipt(connection, address);
      if (amount > 0n) {
        return { success: true, attempts: attempt, onChainAmount: amount };
      }
      console.warn(
        `⚠️  GraphQL 200 但链上还查不到 USDC，继续等下一次响应（或 s 跳过）`,
      );
      continue;
    }
    const preview = JSON.stringify(body).slice(0, 240);
    console.log(`✗ 第 ${attempt} 次失败 status=${status} body=${preview}`);

    // GraphQL 失败常见原因：reCAPTCHA token 过期。尝试自动重试一次。
    const errMsg = preview.toLowerCase();
    if (errMsg.includes("recaptcha") || errMsg.includes("captcha")) {
      console.log(`>>> 检测到 reCAPTCHA 错误，自动重试...`);
      const r = await tryClickRecaptcha(page).catch(() => "challenge" as const);
      if (r === "passed") {
        console.log(`✓ reCAPTCHA 重新通过，自动点 Send`);
        await clickSendButton(page);
      } else if (r === "challenge") {
        console.log(`>>> 弹了挑战，请手动解；解完脚本会自动点 Send`);
      }
    } else {
      console.log(`>>> 在浏览器手动重新点 Send 或输入 s 跳过`);
    }
  }
}

async function buildContext(): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  // 持久化 user-data-dir + stealth，让 reCAPTCHA 信任度最大化
  const context = (await playwrightChromium.launchPersistentContext(
    BROWSER_PROFILE_DIR,
    {
      headless: false,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--lang=zh-CN",
      ],
      extraHTTPHeaders: {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    },
  )) as unknown as BrowserContext;
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// ===== 主流程 =====
async function main() {
  setupStdin();

  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const accounts = loadAccounts();
  const progress = loadProgress();

  console.log(`查询 ${accounts.length} 个账户的链上 USDC 余额...`);
  const onChain = await fetchAllOnChainUsdc(connection, accounts);

  const pending: StoredAccount[] = [];
  let consolidatedCnt = 0;
  let onChainCnt = 0;
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i]!;
    const p = progress[acc.publicKey];
    const consolidated = !!(p?.consolidatedAt && p.consolidatedAt !== "");
    const amount = onChain[i] ?? 0n;
    if (consolidated) {
      consolidatedCnt++;
      continue;
    }
    if (amount > 0n) {
      onChainCnt++;
      if (!p?.claimedAt) {
        updateProgress(acc.publicKey, {
          claimedAt: new Date().toISOString(),
          claimError: undefined,
        });
      }
      continue;
    }
    pending.push(acc);
  }

  console.log(
    `账户总数 ${accounts.length}：已归集 ${consolidatedCnt}，链上已有 USDC ${onChainCnt}，待领取 ${pending.length}`,
  );
  if (pending.length === 0) {
    console.log("没有需要领取的账户，跳过");
    return;
  }
  console.log(
    `小提示：终端命令  s = 跳过当前账户   q = 处理完当前账户后退出`,
  );
  console.log(`浏览器 profile 持久化目录：${BROWSER_PROFILE_DIR}`);

  const { context, page } = await buildContext();
  page.on("response", (resp) => {
    if (
      resp.url().includes(GRAPHQL_PATH) &&
      resp.request().method() === "POST"
    ) {
      console.log(`[graphql] ${resp.status()} ${resp.url()}`);
    }
  });
  await setupFaucetPage(page);

  for (let i = 0; i < pending.length; i++) {
    if (quitRequested) {
      console.log(">>> 退出请求已生效，停止后续账户处理");
      break;
    }
    const acc = pending[i]!;
    const label = `[${i + 1}/${pending.length}] ${acc.publicKey}`;
    console.log(`\n=== ${label} ===`);
    try {
      const outcome = await claimOne(connection, page, acc.publicKey);
      if (outcome.success) {
        updateProgress(acc.publicKey, {
          claimedAt: new Date().toISOString(),
          claimError: undefined,
        });
        const human =
          outcome.onChainAmount !== undefined
            ? `（链上 +${Number(outcome.onChainAmount) / 1_000_000} USDC）`
            : "";
        console.log(
          `✓ ${label} 领取成功${
            outcome.attempts && outcome.attempts > 1
              ? `（第 ${outcome.attempts} 次尝试）`
              : ""
          }${human}`,
        );
      } else {
        updateProgress(acc.publicKey, {
          claimError: outcome.errorMessage ?? "unknown",
        });
        console.log(`- ${label} 已跳过/未完成 (${outcome.errorMessage})`);
      }
    } catch (err) {
      console.error(`✗ ${label} 异常：`, err);
      updateProgress(acc.publicKey, {
        claimError: (err as Error).message,
      });
      await setupFaucetPage(page).catch(() => undefined);
    }
    // 进入下一个账户前给页面一点时间清掉 toast / 重置 reCAPTCHA token
    await page.waitForTimeout(1500 + Math.random() * 1000);
  }

  console.log(
    "\n领取流程结束。可以再次运行 npm run claim 来重试失败/跳过项。",
  );
  await context.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
