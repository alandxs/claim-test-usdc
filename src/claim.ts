import readline from "node:readline";
import { chromium, type Page } from "playwright";
import { loadAccounts, loadProgress, updateProgress } from "./storage.js";

const FAUCET_URL = "https://faucet.circle.com/";
const GRAPHQL_PATH = "/api/graphql";
const PER_REQUEST_TIMEOUT_MS = 10 * 60_000; // 给 reCAPTCHA 留 10 分钟

// ---- stdin 控制：'s' + 回车 → 跳过当前；'q' + 回车 → 退出 ----
let skipResolver: (() => void) | null = null;
let quitRequested = false;

function setupStdin() {
  if (!process.stdin.isTTY) return; // 没 TTY 就不监听
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === "s" || cmd === "skip") {
      console.log(">>> 收到跳过指令，等当前响应处理完后跳到下一个账户");
      skipResolver?.();
    } else if (cmd === "q" || cmd === "quit") {
      console.log(">>> 收到退出指令，将在当前账户处理完后退出");
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

async function setupFaucetPage(page: Page) {
  await page.goto(FAUCET_URL, { waitUntil: "domcontentloaded" });

  // 1) 选 USDC Tab（默认应该已经是，做一次保险点击）
  await page
    .getByRole("radio", { name: "USDC" })
    .check({ timeout: 10_000 })
    .catch(() => undefined);

  // 2) 打开 Network 下拉，选 Solana Devnet
  const networkButton = page.getByRole("button", { name: /^Network/ });
  await networkButton.click({ timeout: 10_000 });
  await page
    .getByRole("option", { name: "Solana Devnet" })
    .click({ timeout: 10_000 });

  await page.waitForTimeout(800);

  console.log("已自动选好 Network=Solana Devnet, Token=USDC");
}

interface ClaimOutcome {
  success: boolean;
  raw: unknown;
  errorMessage?: string;
  attempts: number;
}

async function claimOne(page: Page, address: string): Promise<ClaimOutcome> {
  const addressBox = page.getByRole("textbox", { name: "Send to" });
  await addressBox.click();
  await addressBox.fill("");
  await addressBox.fill(address);

  console.log(
    `\n>>> 已自动填入地址。请在浏览器中：① 点 reCAPTCHA 复选框（出现挑战就解一下）② 点 'Send 20 USDC' 按钮`,
  );
  console.log(`>>> 失败可在浏览器直接重试，脚本会一直等到本地址领取成功`);
  console.log(`>>> 想跳过该地址：在终端输入 s + 回车   想退出脚本：q + 回车`);

  let attempt = 0;
  // 关键：失败 ≠ 进入下一个，循环等下一次响应/或用户跳过
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
        const status = resp.status();
        let body: unknown = null;
        try {
          body = await resp.json();
        } catch {
          body = await resp.text().catch(() => null);
        }
        return { kind: "graphql" as const, status, body };
      });

    const skipPromise = waitForSkip().then(
      () => ({ kind: "skip" as const }),
    );

    const winner = await Promise.race([responsePromise, skipPromise]).catch(
      (err) => ({ kind: "timeout" as const, error: (err as Error).message }),
    );

    // 重置 skip resolver，避免误触下一个账户
    skipResolver = null;

    if (winner.kind === "skip") {
      return {
        success: false,
        raw: null,
        errorMessage: "user-skip",
        attempts: attempt,
      };
    }

    if (winner.kind === "timeout") {
      console.log(`✗ 第 ${attempt} 次尝试超时（${PER_REQUEST_TIMEOUT_MS / 60_000} 分钟无响应）`);
      console.log(`>>> 还想继续等？在浏览器重新点 Send 即可，或输入 s + 回车跳过`);
      continue;
    }

    const { status, body } = winner;
    const bodyObj = body as
      | { data?: Record<string, unknown>; errors?: unknown[] }
      | null;
    const hasErrors =
      bodyObj && Array.isArray(bodyObj.errors) && bodyObj.errors.length > 0;
    const ok =
      status >= 200 && status < 300 && !!bodyObj?.data && !hasErrors;

    if (ok) {
      return {
        success: true,
        raw: body,
        attempts: attempt,
      };
    }

    const bodyStr = JSON.stringify(body);
    const preview = bodyStr ? bodyStr.slice(0, 240) : String(body);
    console.log(`✗ 第 ${attempt} 次失败：status=${status} body=${preview}`);
    console.log(
      `>>> 在浏览器重新点 reCAPTCHA + 'Send 20 USDC' 重试；想跳过输入 s + 回车`,
    );
    // 不刷新页面，让用户继续操作
  }
}

async function main() {
  setupStdin();

  const accounts = loadAccounts();
  const progress = loadProgress();
  const pending = accounts.filter((a) => !progress[a.publicKey]?.claimedAt);
  if (pending.length === 0) {
    console.log("所有账户都已成功领取，跳过");
    return;
  }
  console.log(
    `共 ${accounts.length} 个账户，已领 ${
      accounts.length - pending.length
    } 个，剩余 ${pending.length} 个`,
  );
  console.log(`小提示：终端命令  s = 跳过当前账户   q = 处理完当前账户后退出\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();

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
      const outcome = await claimOne(page, acc.publicKey);
      if (outcome.success) {
        updateProgress(acc.publicKey, {
          claimedAt: new Date().toISOString(),
          claimError: undefined,
        });
        console.log(
          `✓ ${label} 领取成功${outcome.attempts > 1 ? `（第 ${outcome.attempts} 次尝试）` : ""}`,
        );
      } else {
        updateProgress(acc.publicKey, {
          claimError: outcome.errorMessage ?? "unknown",
        });
        console.log(`- ${label} 已跳过/未完成（${outcome.errorMessage}）`);
      }
    } catch (err) {
      console.error(`✗ ${label} 异常：`, err);
      updateProgress(acc.publicKey, {
        claimError: (err as Error).message,
      });
      // 异常时刷新页面，避免 UI 卡死
      await setupFaucetPage(page).catch(() => undefined);
    }

    // 进入下一个账户前给页面一点时间清掉 toast / 重置状态
    await page.waitForTimeout(1200);
  }

  console.log(
    "\n领取流程结束。可以再次运行 npm run claim 来重试失败/跳过项。",
  );
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
