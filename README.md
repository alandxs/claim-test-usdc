# claim-test-usdc

批量从 [Circle Faucet](https://faucet.circle.com/) 领取 **Solana Devnet** 的 Test USDC，并归集到指定地址。

> 默认目标地址：`Hngd6dHVsmarpmRh3VPtZook7xu1szdysWth8pNKGgnM`（可在 `.env` 修改）

## 工作原理

Circle 水龙头按 **接收地址** 限速（每 2 小时 / 每对网络+币种），所以一次只能领 20 USDC。
脚本通过：

1. 生成 100 个全新临时 Solana 账户（保存私钥到本地）；
2. 你提供的"资助账户"给每个临时账户分发少量 Devnet SOL 作 gas；
3. 用 Playwright 启动一个真实 Chromium 窗口，依次自动填入 100 个地址，**reCAPTCHA 由你手动点**（脚本会等响应）；
4. 全部领完后，逐个把临时账户里的 USDC 转入目标地址，并顺手关闭临时 ATA 把租金 SOL 回收给资助账户。

最终目标地址会收到 100 × 20 = **2000 Devnet USDC**。

## 安装

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

## 配置 `.env`

| 变量 | 必填 | 说明 |
|---|---|---|
| `TARGET_ADDRESS` | ✅ | 归集目标地址（默认已填入题目要求的地址） |
| `FUNDER_SECRET_KEY` | ✅ | 资助账户私钥（base58 字符串 **或** Solana CLI 风格的 `[1,2,3,...]` JSON 数组）。该账户需要在 Devnet 至少有 ~1 SOL（去 https://faucet.solana.com 领取） |
| `SOL_PER_ACCOUNT` |  | 每个临时账户分发多少 SOL，默认 `0.005` 已经足够开 ATA + 转账 + 关 ATA |
| `ACCOUNT_COUNT` |  | 想生成多少个账户，默认 `100` |
| `SOLANA_RPC_URL` |  | RPC，默认 `https://api.devnet.solana.com`。如频繁 429，建议换成 Helius / QuickNode 的 Devnet 节点 |
| `USDC_MINT` |  | Devnet USDC mint，默认即 `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## 一键运行

```bash
npm run all
```

等价于按顺序执行下面 4 步。**强烈建议第一次运行时分步执行**，方便观察。

### 1. 生成 100 个账户

```bash
npm run generate
```

私钥写入 `data/accounts.json`（已 .gitignore，**不要泄露**）。

### 2. 给临时账户分发 SOL（gas）

```bash
npm run fund
```

每 10 个账户合并到一个 tx，共发 10 次。

### 3. 领取 USDC（半自动）

```bash
npm run claim
```

脚本会：

- 启动 Chromium 窗口，自动选好 `Network = Solana Devnet` + `Token = USDC`；
- 循环每个账户：自动填地址、自动点 `Send 20 USDC` 按钮；
- **你只需要点一次 reCAPTCHA 复选框**（如果出现图片挑战就解一下）；
- 脚本检测到 GraphQL 响应后自动进入下一个；
- 中断了再次运行 `npm run claim` 会从未完成处续跑（用 `data/progress.json` 记录进度）。

> 因为 reCAPTCHA Enterprise 有反自动化检测，**不要把鼠标放着不管**——保持窗口在前台、偶尔挪一下鼠标，通过率更高。

### 4. 归集到目标地址

```bash
npm run consolidate
```

逐个账户：
1. 必要时为目标地址创建 USDC ATA（一次性）；
2. 把临时账户的 USDC 全部 `transferChecked` 到目标 ATA；
3. 关闭临时账户的 USDC ATA，把 ~0.002 SOL 租金返回给资助账户。

### 实时查看进度

```bash
npm run balances
```

打印：每个账户当前 SOL/USDC 余额、已资助/已领取/已归集的统计、目标地址 USDC 余额。

## 文件说明

```
src/
├── config.ts        # 读 .env，加载资助账户私钥
├── storage.ts       # data/accounts.json + data/progress.json 读写
├── generate.ts      # 生成账户
├── fund.ts          # 分发 SOL（每 10 个一笔交易）
├── claim.ts         # Playwright 半自动领取
├── consolidate.ts   # 归集 USDC + 关闭临时 ATA
└── balances.ts      # 余额/状态查询
data/
├── accounts.json    # 生成出的 100 个账户（含私钥，机密！）
└── progress.json    # 每个账户进度：fundedAt / claimedAt / claimError / consolidatedAt
```

## 常见问题

**Q: 为什么不直接用 Circle 官方 `/v1/faucet/drips` API？**
A: 那个 API 每个开发者 API Key 每天只能领 5–10 次，100 次需要 10–20 个不同账号的 Key，反而比手点 reCAPTCHA 麻烦。

**Q: 我能完全自动化（不点 reCAPTCHA）吗？**
A: 可以，把 `claim.ts` 里调用 reCAPTCHA 解题服务（2Captcha / CapSolver）的 token 注入到 GraphQL 请求里，但需要付费 API Key（≈ $0.003/次）。本脚本默认不集成。

**Q: 临时账户收了 20 USDC，还需要 SOL 吗？**
A: 需要。Solana 上 SPL Token 的 ATA 在第一次接收时会被 Circle 帮我们建好（gas 由水龙头出），但 **从临时账户转出 USDC 时**必须由账户自己付 ~5000 lamports 的 gas。所以每个临时账户至少要有几千 lamports。脚本默认给 0.005 SOL，富余很多。

**Q: 跑到一半中断怎么办？**
A: 直接重跑对应步骤。`progress.json` 记录每个账户的状态，已完成的会自动跳过。

**Q: 100 个账户私钥很多，怎么处理？**
A: `data/` 目录已经在 `.gitignore` 里。Devnet USDC 没有真实价值，全部归集完就可以放心删除 `data/`，或者保留以备日后再次薅 Devnet 水龙头。

## 安全提示

- `data/accounts.json` 与 `.env` 包含**真实私钥**，不要 `git add`、不要发到群里、不要截图。
- `FUNDER_SECRET_KEY` 建议用一个**只持有少量 Devnet SOL**的临时账号，不要用主账号。
