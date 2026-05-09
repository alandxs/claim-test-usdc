import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  SOLANA_RPC_URL,
  TARGET_ADDRESS,
  USDC_MINT,
  loadFunder,
} from "./config.js";
import {
  accountToKeypair,
  loadAccounts,
  loadProgress,
  updateProgress,
} from "./storage.js";

const USDC_DECIMALS = 6;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const accounts = loadAccounts();
  const progress = loadProgress();
  const funder = loadFunder(); // 用作"租金回收账户"，并在没 SOL 时托底续费

  const targetAta = getAssociatedTokenAddressSync(USDC_MINT, TARGET_ADDRESS);

  // 先确保目标地址有 USDC 的 ATA。由 funder 出资创建。
  {
    const targetAtaInfo = await connection.getAccountInfo(targetAta);
    if (!targetAtaInfo) {
      console.log(
        `目标地址 ${TARGET_ADDRESS.toBase58()} 没有 USDC ATA，使用 funder 创建中...`,
      );
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          funder.publicKey,
          targetAta,
          TARGET_ADDRESS,
          USDC_MINT,
        ),
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [funder]);
      console.log(`目标 ATA 创建成功 sig=${sig}`);
    } else {
      console.log(`目标 ATA 已存在: ${targetAta.toBase58()}`);
    }
  }

  // 过滤待归集账户：已领取且未归集
  const pending = accounts.filter(
    (a) =>
      progress[a.publicKey]?.claimedAt && !progress[a.publicKey]?.consolidatedAt,
  );
  console.log(`待归集账户数：${pending.length} / ${accounts.length}`);

  let totalTransferredRaw = 0n;
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const acc = pending[i]!;
    const label = `[${i + 1}/${pending.length}] ${acc.publicKey}`;
    const kp = accountToKeypair(acc);
    const sourceAta = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);

    try {
      // 1) 读 USDC 余额
      let amountRaw = 0n;
      try {
        const tokenAcc = await getAccount(connection, sourceAta);
        amountRaw = tokenAcc.amount;
      } catch {
        console.log(`${label} 没有 ATA / 余额，跳过`);
        updateProgress(acc.publicKey, {
          consolidatedAt: new Date().toISOString(),
          consolidatedSig: "skip:no-balance",
        });
        continue;
      }

      if (amountRaw === 0n) {
        console.log(`${label} ATA 余额为 0，跳过转账，仅尝试关闭`);
      }

      // 2) 检查 SOL 余额（gas）
      const solBalance = await connection.getBalance(kp.publicKey);
      if (solBalance < 1_000_000) {
        // 不足 0.001 SOL，提示但仍尝试（可能转账失败）
        console.warn(
          `${label} SOL 余额低 (${solBalance / LAMPORTS_PER_SOL})，可能 gas 不足`,
        );
      }

      // 3) 构造交易：transferChecked → 关闭 ATA 把租金返还给 funder（节省一些）
      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      );

      // 确保目标 ATA 存在（idempotent，不存在才创建；由当前账户付费）
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          kp.publicKey,
          targetAta,
          TARGET_ADDRESS,
          USDC_MINT,
        ),
      );

      if (amountRaw > 0n) {
        tx.add(
          createTransferCheckedInstruction(
            sourceAta,
            USDC_MINT,
            targetAta,
            kp.publicKey,
            amountRaw,
            USDC_DECIMALS,
            [],
            TOKEN_PROGRAM_ID,
          ),
        );
      }

      // 关掉 source ATA，把租金 SOL 返还给 funder（顺手回收一点 SOL）
      tx.add(
        createCloseAccountInstruction(
          sourceAta,
          funder.publicKey, // 租金接收方
          kp.publicKey, // ATA 所有者
        ),
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [kp], {
        commitment: "confirmed",
      });

      const human = Number(amountRaw) / 10 ** USDC_DECIMALS;
      totalTransferredRaw += amountRaw;
      okCount++;

      updateProgress(acc.publicKey, {
        consolidatedAt: new Date().toISOString(),
        consolidatedSig: sig,
      });

      console.log(`✓ ${label} 转出 ${human} USDC，sig=${sig}`);
    } catch (err) {
      failCount++;
      console.error(`✗ ${label} 失败：`, (err as Error).message);
    }

    await sleep(200);
  }

  console.log("\n========== 归集汇总 ==========");
  console.log(
    `成功：${okCount}，失败：${failCount}，累计转入 ${
      Number(totalTransferredRaw) / 10 ** USDC_DECIMALS
    } USDC → ${TARGET_ADDRESS.toBase58()}`,
  );

  // 最后查询一下目标账户余额
  try {
    const finalAcc = await getAccount(connection, targetAta);
    console.log(
      `目标地址当前 USDC 余额：${
        Number(finalAcc.amount) / 10 ** USDC_DECIMALS
      }`,
    );
  } catch (e) {
    console.warn("查询目标余额失败：", (e as Error).message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
