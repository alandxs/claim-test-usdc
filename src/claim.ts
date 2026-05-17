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

// Circle Faucet 的 reCAPTCHA 是 v3 (默认) + v2 复选框 fallback 的混合模式。
// 这两个 sitekey 是从 Circle 前端 __NEXT_DATA__ 抓出来的，长期稳定。
// v3 阈值 = 0.7（前端配置 reCaptchaThreshold）。
const RECAPTCHA_V3_SITEKEY = "6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2";
const RECAPTCHA_V2_SITEKEY = "6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve";

// 单次"等响应"心跳间隔，可通过 CLAIM_TIMEOUT_MS 覆盖
const PER_REQUEST_TIMEOUT_MS =
  Number.parseInt(process.env.CLAIM_TIMEOUT_MS ?? "", 10) || 30 * 60_000;

// 链上确认 USDC 到账的最长等待时间 / 轮询间隔
const ONCHAIN_CONFIRM_TIMEOUT_MS =
  Number.parseInt(process.env.CLAIM_ONCHAIN_CONFIRM_MS ?? "", 10) || 90_000;
const ONCHAIN_POLL_INTERVAL_MS = 3_000;

// 浏览器持久化 profile 路径（让 reCAPTCHA 信任度更高）
const BROWSER_PROFILE_DIR = path.resolve(
  process.cwd(),
  process.env.BROWSER_PROFILE_DIR ?? ".browser-profile",
);

// 2Captcha 配置
const TWOCAPTCHA_API_KEY = (process.env.TWOCAPTCHA_API_KEY ?? "").trim();
const TWOCAPTCHA_TIMEOUT_MS =
  Number.parseInt(process.env.TWOCAPTCHA_TIMEOUT_MS ?? "", 10) || 180_000;
const TWOCAPTCHA_POLL_INTERVAL_MS = 5_000;
const TWOCAPTCHA_V3_MIN_SCORE = process.env.TWOCAPTCHA_V3_MIN_SCORE ?? "0.7";

// 卡顿心跳：N 秒没收到 GraphQL 响应就输出一次状态、并在 Send 重新 enable 时再点一次
const STUCK_RETRIGGER_MS =
  Number.parseInt(process.env.CLAIM_STUCK_RETRIGGER_MS ?? "", 10) || 30_000;

// 单账户最长尝试时间，超时则视作失败跳过（下次 npm run claim 时会自动重试）
const CLAIM_HARD_TIMEOUT_MS =
  Number.parseInt(process.env.CLAIM_HARD_TIMEOUT_MS ?? "", 10) || 5 * 60_000;

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

// ===== 2Captcha HTTP API =====
// 通用 2Captcha 提交+轮询。method=userrecaptcha 同时支持 v2 / v3，差别只在参数。
async function submitAndPoll2Captcha(
  apiKey: string,
  params: Record<string, string>,
): Promise<string | null> {
  const submitUrl = new URL("https://2captcha.com/in.php");
  submitUrl.searchParams.set("key", apiKey);
  submitUrl.searchParams.set("json", "1");
  for (const [k, v] of Object.entries(params)) submitUrl.searchParams.set(k, v);

  let captchaId: string;
  try {
    const res = await fetch(submitUrl.toString());
    const body = (await res.json()) as { status: number; request: string };
    if (body.status !== 1) {
      console.error(`  [2Captcha] 提交失败: ${body.request}`);
      return null;
    }
    captchaId = body.request;
    console.log(
      `  [2Captcha] 已提交 (id=${captchaId}, ${params.version ?? "v2"})，等待解题...`,
    );
  } catch (err) {
    console.error(`  [2Captcha] 提交异常: ${(err as Error).message}`);
    return null;
  }

  const deadline = Date.now() + TWOCAPTCHA_TIMEOUT_MS;
  // 首次稍等久一点（2Captcha 解 reCAPTCHA 通常 15-90s）
  await new Promise((r) => setTimeout(r, 15_000));
  while (Date.now() < deadline) {
    try {
      const resUrl = new URL("https://2captcha.com/res.php");
      resUrl.searchParams.set("key", apiKey);
      resUrl.searchParams.set("action", "get");
      resUrl.searchParams.set("id", captchaId);
      resUrl.searchParams.set("json", "1");
      const r = await fetch(resUrl.toString());
      const rb = (await r.json()) as { status: number; request: string };
      if (rb.status === 1) {
        console.log(
          `  [2Captcha] 解出 token ✓ (id=${captchaId}, ${rb.request.slice(0, 24)}...)`,
        );
        return rb.request;
      }
      if (rb.request !== "CAPCHA_NOT_READY") {
        console.error(`  [2Captcha] 解题出错 (id=${captchaId}): ${rb.request}`);
        return null;
      }
    } catch (err) {
      console.warn(`  [2Captcha] 轮询异常: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, TWOCAPTCHA_POLL_INTERVAL_MS));
  }
  console.error(`  [2Captcha] 解题超时 (${TWOCAPTCHA_TIMEOUT_MS / 1000}s)`);
  return null;
}

async function solveRecaptchaV3(
  sitekey: string,
  pageurl: string,
  action: string,
): Promise<string | null> {
  if (!TWOCAPTCHA_API_KEY) return null;
  // Circle 用 reCAPTCHA Enterprise（劫持日志显示 grecaptcha.enterprise.execute），
  // 所以必须传 enterprise=1，否则 2Captcha 解出来的是普通 v3 token，后端会返回
  // RECAPTCHA_ASSESSMENT_FAILED 拒绝。
  return submitAndPoll2Captcha(TWOCAPTCHA_API_KEY, {
    method: "userrecaptcha",
    version: "v3",
    enterprise: "1",
    googlekey: sitekey,
    pageurl,
    action: action || "submit",
    min_score: TWOCAPTCHA_V3_MIN_SCORE,
  });
}

async function solveRecaptchaV2(
  sitekey: string,
  pageurl: string,
): Promise<string | null> {
  if (!TWOCAPTCHA_API_KEY) return null;
  return submitAndPoll2Captcha(TWOCAPTCHA_API_KEY, {
    method: "userrecaptcha",
    enterprise: "1", // v2 fallback 也是 Enterprise sitekey
    googlekey: sitekey,
    pageurl,
  });
}

// ===== reCAPTCHA 劫持 =====
// 关键：在每个页面加载前注入一段脚本，等 window.grecaptcha 出现后劫持 execute。
// 被劫持的 execute 会先调 2Captcha 拿 v3 token，失败再 fallback 原始函数。
// react-google-recaptcha-v3 内部正是用 grecaptcha.execute(siteKey, {action}) 拿 token，
// 所以 Circle 前端拿到的就是 2Captcha 的 token，提交时也带这个 token 给后端。
async function installRecaptchaHijack(context: BrowserContext): Promise<void> {
  // 1) 暴露 Node 端的解题函数给浏览器
  await context.exposeFunction(
    "__cursorSolveRecaptchaV3",
    async (sitekey: string, action: string): Promise<string | null> => {
      console.log(
        `>>> [劫持] grecaptcha.execute(${sitekey.slice(0, 10)}..., action=${action}) → 调 2Captcha 解 v3`,
      );
      const token = await solveRecaptchaV3(sitekey, FAUCET_URL, action).catch(
        (err) => {
          console.warn(`  [劫持] solveRecaptchaV3 异常: ${err?.message}`);
          return null;
        },
      );
      return token;
    },
  );
  // 2) 把劫持脚本里的 console.log 转发到 Node 端（保证一定能看到诊断日志）
  await context.exposeFunction("__cursorHijackLog", (msg: string) => {
    console.log(`  [hijack-log] ${msg}`);
  });

  // 3) 在每个页面加载前注入劫持脚本。
  //    ⚠️ 必须用字符串形式注入！因为 tsx/esbuild 编译 TS 代码时会注入 __name 辅助函数，
  //    但 page 里没有 __name，会立刻 `__name is not defined` 让 init script 整段失败。
  //    用字符串注入的 JS 代码不经过 TS 编译，原样进入浏览器。
  const HIJACK_SCRIPT = `
(function () {
  var w = window;
  function HLOG(m) {
    try { if (w.__cursorHijackLog) w.__cursorHijackLog(String(m)); } catch (e) {}
    try { console.log('[hijack] ' + m); } catch (e) {}
  }
  HLOG('init script loaded, installing grecaptcha hijack');

  function wrapExecute(orig) {
    return function (siteKey, opts) {
      var sk = typeof siteKey === 'string' ? siteKey : '';
      var action = (opts && typeof opts.action === 'string' && opts.action) || 'submit';
      HLOG('grecaptcha.execute called sitekey=' + sk.slice(0, 12) + '... action=' + action);
      var p = (async function () {
        if (sk && w.__cursorSolveRecaptchaV3) {
          try {
            var t = await w.__cursorSolveRecaptchaV3(sk, action);
            if (t && typeof t === 'string' && t.length > 20) {
              HLOG('✓ 2Captcha token (' + t.length + ' chars) 返回给前端');
              return t;
            }
            HLOG('2Captcha 返回空，fallback 到原始 execute');
          } catch (e) {
            HLOG('2Captcha 调用异常 fallback: ' + e);
          }
        }
        if (typeof orig === 'function') return orig(siteKey, opts);
        throw new Error('[hijack] no original grecaptcha.execute available');
      })();
      return p;
    };
  }

  function buildProxy(realObj) {
    return new Proxy(realObj, {
      get: function (target, prop, receiver) {
        if (prop === 'execute') return wrapExecute(target.execute);
        if (prop === 'enterprise' && target.enterprise) return buildProxy(target.enterprise);
        return Reflect.get(target, prop, receiver);
      },
      set: function (target, prop, value, receiver) {
        return Reflect.set(target, prop, value, receiver);
      }
    });
  }

  var _grecaptcha = undefined;
  try {
    Object.defineProperty(window, 'grecaptcha', {
      configurable: true,
      enumerable: true,
      get: function () { return _grecaptcha ? buildProxy(_grecaptcha) : undefined; },
      set: function (v) {
        _grecaptcha = v;
        HLOG('window.grecaptcha 被赋值 (execute=' + (typeof (v && v.execute)) + ', enterprise=' + !!(v && v.enterprise) + ')');
      }
    });
    HLOG('window.grecaptcha 读写已被代理，等待 reCAPTCHA 脚本加载');
  } catch (e) {
    HLOG('安装 grecaptcha 代理失败: ' + e);
  }

  // 关键兜底：reCAPTCHA 加载脚本通常这样：
  //   window.grecaptcha = {};            // 这步触发我们的 setter
  //   ...异步...
  //   _grecaptcha.execute = function ... // 直接改真实对象属性，绕过 proxy.set
  // 所以我们额外用 setInterval 持续直接替换 _grecaptcha.execute（覆盖真实对象上的）
  // 这样无论 reCAPTCHA 内部怎么持有 execute 引用都会拿到 wrap 版。
  var _patchedExecuteRef = null;
  var _patchedEnterpriseRef = null;
  function patchDirectly(obj, label) {
    if (!obj) return;
    if (typeof obj.execute === 'function') {
      // 已经包装过同一个 ref 则跳过
      var ref = obj.execute;
      if ((label === 'main' && _patchedExecuteRef === ref) ||
          (label === 'enterprise' && _patchedEnterpriseRef === ref)) return;
      var orig = ref;
      obj.execute = wrapExecute(orig);
      if (label === 'main') _patchedExecuteRef = obj.execute;
      else _patchedEnterpriseRef = obj.execute;
      HLOG('✓ 直接替换 _grecaptcha' + (label === 'enterprise' ? '.enterprise' : '') + '.execute（已包装）');
    }
  }
  setInterval(function () {
    if (!_grecaptcha) return;
    patchDirectly(_grecaptcha, 'main');
    if (_grecaptcha.enterprise) patchDirectly(_grecaptcha.enterprise, 'enterprise');
  }, 80);
})();
`;
  await context.addInitScript({ content: HIJACK_SCRIPT });
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

// OneTrust Cookie 弹窗 best-effort 关闭（持久化 profile 后只会出现一次）
async function dismissCookieBannerIfPresent(page: Page): Promise<void> {
  try {
    const accepted = await page.evaluate(() => {
      const ids = [
        "onetrust-accept-btn-handler",
        "accept-recommended-btn-handler",
      ];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && (el as HTMLElement).offsetParent !== null) {
          (el as HTMLButtonElement).click();
          return id;
        }
      }
      const all = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      );
      for (const b of all) {
        const t = (b.textContent || "").trim();
        if (/^(Accept All|Accept all|\u63a5\u53d7\u5168\u90e8|Got it)$/.test(t)) {
          b.click();
          return t;
        }
      }
      return null;
    });
    if (accepted) {
      console.log(`  已关闭 Cookie 弹窗 (${accepted})`);
      await page.waitForTimeout(400);
    }
  } catch {
    // ignore
  }
}

async function setupFaucetPage(page: Page) {
  await page.goto(FAUCET_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await dismissCookieBannerIfPresent(page).catch(() => undefined);
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
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const jitterX = (Math.random() - 0.5) * 2;
    const jitterY = (Math.random() - 0.5) * 2;
    const x = from.x + (toX - from.x) * ease + jitterX;
    const y = from.y + (toY - from.y) * ease + jitterY;
    await page.mouse.move(x, y);
    await page.waitForTimeout(8 + Math.random() * 14);
  }
}

// 自动点 "Send 20 USDC" 按钮，三层兜底（普通 click → DOM 强制 → form.submit）
async function clickSendButton(
  page: Page,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // 第 1 层：Playwright 标准 actionability click
  while (Date.now() < deadline) {
    const candidates = [
      page.getByRole("button", { name: /Send\s*20\s*USDC/i }).first(),
      page.getByRole("button", { name: /Send.*USDC/i }).first(),
      page.getByRole("button", { name: /^Send\s*\d/i }).first(),
      page.getByRole("button", { name: /^Send\b/i }).first(),
      page.locator('button:has-text("Send 20")').first(),
      page.locator('form button[type="submit"]:visible').first(),
    ];
    for (const btn of candidates) {
      try {
        if (!(await btn.isVisible({ timeout: 300 }))) continue;
        const enabled = await btn
          .isEnabled({ timeout: 300 })
          .catch(() => true);
        if (!enabled) continue;
        await btn.click({ timeout: 2_500 });
        return true;
      } catch {
        // try next
      }
    }
    await page.waitForTimeout(400);
  }

  // 第 2 层：DOM 强制
  type DomResult =
    | { ok: true; text: string }
    | { ok: false; visibleButtons: string[] };
  const dom: DomResult = await page
    .evaluate((): DomResult => {
      function vis(el: Element): boolean {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = window.getComputedStyle(el);
        return (
          s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"
        );
      }
      const all = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, [role=button], input[type=submit]",
        ),
      ).filter(vis);
      const target =
        all.find((b) =>
          /Send.*USDC|Send\s*20/i.test((b.textContent || "").trim()),
        ) ||
        all.find((b) => /^Send\b/i.test((b.textContent || "").trim())) ||
        all.find(
          (b) =>
            (b as HTMLInputElement).type === "submit" ||
            b.getAttribute("type") === "submit",
        );
      if (!target) {
        return {
          ok: false,
          visibleButtons: all.map((b) =>
            (b.textContent || "").trim().slice(0, 50),
          ),
        };
      }
      target.removeAttribute("disabled");
      if ("disabled" in target) {
        try {
          (target as HTMLButtonElement).disabled = false;
        } catch {
          /* ignore */
        }
      }
      const fire = (t: string) => {
        try {
          target.dispatchEvent(
            new MouseEvent(t, { bubbles: true, cancelable: true, view: window }),
          );
        } catch {
          /* ignore */
        }
      };
      fire("mousedown");
      fire("mouseup");
      try {
        target.click();
      } catch {
        /* ignore */
      }
      fire("click");
      return { ok: true, text: (target.textContent || "").trim().slice(0, 50) };
    })
    .catch((): DomResult => ({ ok: false, visibleButtons: ["evaluate-failed"] }));
  if (dom.ok) {
    console.log(`  ✓ DOM 强制点击成功 ("${dom.text}")`);
    return true;
  }

  // 第 3 层：form.submit()
  const submitted = await page
    .evaluate(() => {
      const forms = Array.from(document.querySelectorAll<HTMLFormElement>("form"));
      for (const f of forms) {
        if (f.offsetParent !== null) {
          try {
            f.requestSubmit ? f.requestSubmit() : f.submit();
            return true;
          } catch {
            /* ignore */
          }
        }
      }
      return false;
    })
    .catch(() => false);
  if (submitted) {
    console.log(`  ✓ 通过 form.submit() 触发提交`);
    return true;
  }

  if (!dom.ok && dom.visibleButtons.length > 0) {
    console.error(`  ✗ 自动点击 Send 失败。当前可见按钮：`);
    for (const t of dom.visibleButtons) console.error(`     - "${t}"`);
  }
  return false;
}

// 领取成功后页面会展示 "Get more tokens"，点它回到表单
async function clickGetMoreTokensIfPresent(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: /Get\s*more\s*tokens?/i }).first(),
    page.getByRole("link", { name: /Get\s*more\s*tokens?/i }).first(),
    page.locator('button:has-text("Get more")').first(),
    page.locator('a:has-text("Get more")').first(),
    page.getByRole("button", { name: /try\s*again|continue|back/i }).first(),
  ];
  for (const btn of candidates) {
    try {
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 3_000 });
        await page.waitForTimeout(800);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

// ===== v2 复选框 fallback 监听器 =====
// Circle 后端如果觉得 v3 token 评分仍然低，会回到 v2 复选框。这种情况监听器自动接管：
// 检测 anchor iframe 可见 + g-recaptcha-response 为空 → 调 2Captcha 解 v2 → 注入 token → 再点 Send。
function startV2FallbackMonitor(page: Page): { stop: () => void } {
  let stopped = false;
  let solving = false;
  let lastInjectedAt = 0;
  const COOLDOWN_MS = 25_000;

  async function anchorVisible(): Promise<boolean> {
    const a = page.locator('iframe[src*="recaptcha"][src*="anchor"]').first();
    try {
      if (!(await a.isVisible({ timeout: 400 }))) return false;
      const box = await a.boundingBox().catch(() => null);
      return !!box && box.width > 20 && box.height > 20;
    } catch {
      return false;
    }
  }
  async function tokenAlreadyThere(): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const tas = document.querySelectorAll<HTMLTextAreaElement>(
          'textarea[name="g-recaptcha-response"]',
        );
        for (const ta of tas) if (ta.value && ta.value.length > 20) return true;
        return false;
      });
    } catch {
      return false;
    }
  }
  async function findV2Sitekey(): Promise<string> {
    try {
      const sk = await page.evaluate(() => {
        const f = document.querySelector<HTMLIFrameElement>(
          'iframe[src*="recaptcha"][src*="anchor"]',
        );
        if (f) {
          const m = (f.getAttribute("src") || "").match(/[?&]k=([^&]+)/);
          if (m && m[1]) return decodeURIComponent(m[1]);
        }
        const d = document.querySelector("[data-sitekey]");
        if (d) return d.getAttribute("data-sitekey");
        return null;
      });
      if (sk) return sk;
    } catch {
      // ignore
    }
    return RECAPTCHA_V2_SITEKEY;
  }
  async function injectV2Token(token: string): Promise<boolean> {
    try {
      await page.evaluate((t) => {
        const tas = document.querySelectorAll<HTMLTextAreaElement>(
          'textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response',
        );
        tas.forEach((ta) => {
          ta.value = t;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        });
        // 同时调一遍 reCAPTCHA 内部 callback（私有字段遍历）
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cfg = (window as any).___grecaptcha_cfg;
          if (!cfg || !cfg.clients) return;
          for (const cid of Object.keys(cfg.clients)) {
            const stack: unknown[] = [cfg.clients[cid]];
            const seen = new Set<unknown>();
            while (stack.length) {
              const node = stack.pop();
              if (!node || typeof node !== "object" || seen.has(node)) continue;
              seen.add(node);
              for (const k of Object.keys(node as Record<string, unknown>)) {
                const v = (node as Record<string, unknown>)[k];
                if (k === "callback" && typeof v === "function") {
                  try {
                    (v as (s: string) => void)(t);
                  } catch {
                    /* ignore */
                  }
                } else if (v && typeof v === "object") {
                  stack.push(v);
                }
              }
            }
          }
        } catch {
          /* ignore */
        }
      }, token);
      return true;
    } catch {
      return false;
    }
  }

  (async () => {
    while (!stopped) {
      try {
        const visible = await anchorVisible();
        const has = await tokenAlreadyThere();
        const cooldownOver = Date.now() - lastInjectedAt > COOLDOWN_MS;
        if (visible && !has && !solving && cooldownOver) {
          if (!TWOCAPTCHA_API_KEY) {
            console.log(
              `>>> [v2 监听器] 出现 v2 复选框，但未配置 TWOCAPTCHA_API_KEY，请手动点`,
            );
            await new Promise((r) => setTimeout(r, 8_000));
            continue;
          }
          solving = true;
          console.log(`>>> [v2 监听器] 检测到 v2 复选框，调 2Captcha 解 v2...`);
          try {
            const sitekey = await findV2Sitekey();
            const token = await solveRecaptchaV2(sitekey, FAUCET_URL);
            if (token) {
              const injected = await injectV2Token(token);
              if (injected) {
                lastInjectedAt = Date.now();
                console.log(`✓ [v2 监听器] token 注入，等 Send enable 后再点...`);
                await page.waitForTimeout(1_500);
                const clicked = await clickSendButton(page, 10_000).catch(
                  () => false,
                );
                if (clicked) console.log(`✓ [v2 监听器] 已自动重新点 Send`);
              }
            }
          } catch (err) {
            console.warn(`  [v2 监听器] 异常: ${(err as Error).message}`);
          } finally {
            solving = false;
          }
        }
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 1_200));
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

// 读当前页面状态便于心跳日志
async function readClaimStatus(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const hasAnchor = !!document.querySelector(
        'iframe[src*="recaptcha"][src*="anchor"]',
      );
      const ta = document.querySelector<HTMLTextAreaElement>(
        'textarea[name="g-recaptcha-response"]',
      );
      const hasToken = !!(ta && ta.value && ta.value.length > 20);
      const sendBtn = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => /Send.*USDC|Send\s*20/i.test((b.textContent || "").trim()));
      const sendEnabled = !!sendBtn && !sendBtn.disabled;
      if (hasAnchor && !hasToken) return "v2-checkbox-pending";
      if (hasToken && !sendEnabled) return "token-injected-button-loading";
      if (sendEnabled && !hasAnchor) return "send-enabled-no-captcha";
      if (sendEnabled && hasAnchor) return "send-enabled-captcha-shown";
      return "loading-or-submitted";
    });
  } catch {
    return "unknown";
  }
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
  await dismissCookieBannerIfPresent(page).catch(() => undefined);

  // 关键：清掉上一轮残留的 g-recaptcha-response token，否则下一个账户开始时
  // readClaimStatus 会读到 "token-injected-button-loading" 错误地认为已经有有效 token
  await page
    .evaluate(() => {
      const tas = document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response',
      );
      tas.forEach((ta) => {
        ta.value = "";
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      });
    })
    .catch(() => undefined);

  // 1) 填地址：pressSequentially 模拟人类打字 + 必须 Tab 触发 blur 让 Send 启用
  const addressBox = page.getByRole("textbox", { name: "Send to" });
  await addressBox.click();
  await addressBox.fill("");
  await addressBox.pressSequentially(address, {
    delay: 18 + Math.random() * 25,
  });
  await page.keyboard.press("Tab").catch(() => undefined);
  await page.waitForTimeout(500 + Math.random() * 300);

  // 2) 启动 v2 fallback 监听器（万一 v3 token 被拒绝走到 v2 复选框）
  const monitor = startV2FallbackMonitor(page);

  // 3) 第一次点 Send。Send 被点击时，react-google-recaptcha-v3 内部会调
  //    grecaptcha.execute(SITE_V3, {action:"submit"})，我们劫持过它，所以直接拿到
  //    2Captcha 解出来的 v3 token，整个流程一气呵成。
  const firstClicked = await clickSendButton(page, 10_000);
  if (firstClicked) {
    console.log(`✓ 已点击 Send（第 1 次），等待 reCAPTCHA + GraphQL 响应...`);
  } else {
    console.warn(`⚠️  自动点击 Send 失败，请手动点；或 s 跳过`);
    // 给一个鼠标"路过"动作让 Send 按钮重新被视为已 hover，再试一次
    try {
      const box = await page
        .getByRole("button", { name: /Send.*USDC/i })
        .first()
        .boundingBox();
      if (box) {
        await humanMouseMove(page, box.x + box.width / 2, box.y + box.height / 2);
        await clickSendButton(page, 5_000).catch(() => false);
      }
    } catch {
      /* ignore */
    }
  }

  const claimStartedAt = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    if (Date.now() - claimStartedAt > CLAIM_HARD_TIMEOUT_MS) {
      console.warn(
        `⚠️  当前账户已耗时 ${(CLAIM_HARD_TIMEOUT_MS / 1000).toFixed(0)}s，超过 hard timeout，跳过（下次 npm run claim 会自动重试）`,
      );
      monitor.stop();
      return {
        success: false,
        errorMessage: `hard-timeout-${CLAIM_HARD_TIMEOUT_MS / 1000}s`,
        attempts: attempt,
      };
    }

    const responsePromise = page
      .waitForResponse(
        (resp) => {
          if (!resp.url().includes(GRAPHQL_PATH)) return false;
          if (resp.request().method() !== "POST") return false;
          // /api/graphql 是统一端点：查询限流、余额、token 请求都走这里
          // 只匹配 requestToken mutation 的响应，其他 query 跳过
          const reqBody = resp.request().postData() ?? "";
          if (!/requestToken/i.test(reqBody)) return false;
          return true;
        },
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
    const heartbeat = new Promise<{ kind: "heartbeat" }>((r) =>
      setTimeout(() => r({ kind: "heartbeat" }), STUCK_RETRIGGER_MS),
    );

    const winner = await Promise.race([
      responsePromise,
      skipPromise,
      heartbeat,
    ]).catch((err) => ({
      kind: "error" as const,
      message: (err as Error).message,
    }));
    skipResolver = null;

    if (winner.kind === "skip") {
      monitor.stop();
      return { success: false, errorMessage: "user-skip", attempts: attempt };
    }
    if (winner.kind === "heartbeat") {
      const st = await readClaimStatus(page);
      console.log(
        `… 等响应中（已 ${(attempt * STUCK_RETRIGGER_MS) / 1000}s），状态=${st}`,
      );
      // Send 按钮重新 enable 且没有挑战在跑 → 前一次提交失败，自动再点一次
      if (st === "send-enabled-no-captcha") {
        console.log(`>>> Send 重新可点，自动再点一次`);
        await clickSendButton(page, 5_000).catch(() => false);
      }
      continue;
    }
    if (winner.kind === "error") {
      console.warn(`  等待响应异常: ${winner.message}`);
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
        monitor.stop();
        try {
          await page.waitForTimeout(1_000);
          await clickGetMoreTokensIfPresent(page);
        } catch {
          /* ignore */
        }
        return { success: true, attempts: attempt, onChainAmount: amount };
      }
      console.warn(
        `⚠️  GraphQL 200 但链上还查不到 USDC，继续等下一次响应（或 s 跳过）`,
      );
      continue;
    }

    const preview = JSON.stringify(body).slice(0, 240);
    console.log(`✗ GraphQL 失败 status=${status} body=${preview}`);
    const errMsg = preview.toLowerCase();
    if (status === 429 || /limit|rate/i.test(preview)) {
      console.warn(`>>> 触发限流/速率上限，跳过此账户`);
      monitor.stop();
      return {
        success: false,
        errorMessage: `rate-limited status=${status}`,
        attempts: attempt,
      };
    }
    if (errMsg.includes("recaptcha") || errMsg.includes("captcha")) {
      console.log(
        `>>> reCAPTCHA token 被后端拒绝。等待 v2 复选框出现 / 监听器自动接管，最多 90s`,
      );
      // 关键：不要立刻 form.submit() 重复打后端，那只会得到同样的失败。
      // 正确的做法是：
      //   - 等几秒让 Circle 前端把 v2 复选框 anchor iframe 渲染出来
      //   - 监听器（startV2FallbackMonitor）会自动检测到 anchor → 调 2Captcha v2 → 注入 → 再点 Send
      // 这里只需要被动等下一次 GraphQL 响应即可。
      const v2Deadline = Date.now() + 90_000;
      let v2AppearedAt: number | null = null;
      while (Date.now() < v2Deadline) {
        const st = await readClaimStatus(page);
        if (st === "v2-checkbox-pending" || st === "send-enabled-captcha-shown") {
          if (v2AppearedAt === null) {
            v2AppearedAt = Date.now();
            console.log(
              `… v2 复选框已显示，等待 v2 监听器解题 + 自动注入 token + 再点 Send`,
            );
          }
        }
        if (st === "token-injected-button-loading") {
          console.log(`… token 已注入，前端正在校验 / 按钮即将启用`);
          break;
        }
        await new Promise((r) => setTimeout(r, 1_500));
      }
      // 监听器会在 token 注入后自己再点 Send；我们回到主循环继续等下一次 GraphQL 响应
      continue;
    }
    console.log(`>>> 未知错误，等待人工干预 或 s 跳过`);
  }
}

async function buildContext(): Promise<{
  context: BrowserContext;
  page: Page;
}> {
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
  // 关键：浏览器一打开就装好 reCAPTCHA 劫持，下面 navigate 时已经生效
  await installRecaptchaHijack(context);
  const page = context.pages()[0] ?? (await context.newPage());
  // 把页面 console 转发出来（只过滤太吵的，确保 [hijack] 日志一定可见）
  page.on("console", (msg) => {
    const t = msg.text();
    // 跳过过于吵闹的 React DevTools / GA 等噪音，但保留所有有用日志
    if (/devtools|gtag|gtm\.js|analytics\.js|recaptcha\/api|favicon/i.test(t))
      return;
    if (msg.type() === "error" || /hijack|grecaptcha|recaptcha|captcha|error/i.test(t)) {
      console.log(`  [page:${msg.type()}] ${t}`);
    }
  });
  page.on("pageerror", (err) => {
    console.warn(`  [page:pageerror] ${err.message}`);
  });
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
  if (!TWOCAPTCHA_API_KEY) {
    console.warn(
      "⚠️  未配置 TWOCAPTCHA_API_KEY，劫持脚本会 fallback 到原始 grecaptcha.execute，自动化基本会失败。请在 .env 设置后重跑。",
    );
  } else {
    console.log(
      `✓ 已启用 2Captcha 自动解题（v3 sitekey=${RECAPTCHA_V3_SITEKEY.slice(0, 16)}..., v3 阈值 min_score=${TWOCAPTCHA_V3_MIN_SCORE}）`,
    );
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

    if (i > 0) {
      // 关键：每个新账户开始前完整 reload 一次，让 v3 token / v2 token / React state 都归零
      // 之前直接复用页面会出现：v2 监听器误以为旧 anchor 是新挑战、Send 按钮一直 disabled、
      // page.evaluate 偶发 evaluate-failed 等竞态问题
      console.log(`  正在刷新页面以清空上一轮 reCAPTCHA 状态...`);
      try {
        await page.goto(FAUCET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(800);
        await dismissCookieBannerIfPresent(page).catch(() => undefined);
        await ensureNetworkAndToken(page);
      } catch (e) {
        console.warn(`  reload 异常: ${(e as Error).message}`);
      }
    }

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
