import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  SOLANA_RPC_URL,
  SOL_PER_ACCOUNT,
  loadFunder,
} from "./config.js";
import {
  accountToKeypair,
  loadAccounts,
  loadProgress,
  updateProgress,
} from "./storage.js";

const BATCH_SIZE = 10; // 每个 tx 内一次性转给 N 个账户，省手续费 + 节省时间

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const funder = loadFunder();
  const accounts = loadAccounts();
  const progress = loadProgress();

  const lamportsPerAccount = Math.floor(SOL_PER_ACCOUNT * LAMPORTS_PER_SOL);

  // 过滤出"还没分配过 SOL"的账户
  const pending = accounts.filter((a) => !progress[a.publicKey]?.fundedAt);
  if (pending.length === 0) {
    console.log("所有账户均已资助，跳过");
    return;
  }

  // 余额预检查
  const funderBalance = await connection.getBalance(funder.publicKey);
  const required = lamportsPerAccount * pending.length + 5_000 * Math.ceil(pending.length / BATCH_SIZE);
  console.log(
    `资助账户 ${funder.publicKey.toBase58()} 余额 ${
      funderBalance / LAMPORTS_PER_SOL
    } SOL，本次需要约 ${required / LAMPORTS_PER_SOL} SOL`,
  );
  if (funderBalance < required) {
    throw new Error(
      `资助账户余额不足，请去 https://faucet.solana.com 给它领取 SOL（Devnet）后重试`,
    );
  }

  console.log(`待资助账户数: ${pending.length}，每批 ${BATCH_SIZE}`);

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const tx = new Transaction();
    for (const acc of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: new PublicKey(acc.publicKey),
          lamports: lamportsPerAccount,
        }),
      );
    }
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [funder], {
        commitment: "confirmed",
      });
      const ts = new Date().toISOString();
      for (const acc of batch) {
        updateProgress(acc.publicKey, { fundedAt: ts });
      }
      console.log(
        `[${i / BATCH_SIZE + 1}/${Math.ceil(pending.length / BATCH_SIZE)}] 资助 ${batch.length} 个账户成功 sig=${sig}`,
      );
    } catch (err) {
      console.error(`批次 ${i / BATCH_SIZE + 1} 失败：`, err);
      // 不中断，留待下次重跑（progress 还没标记成功）
    }
    await sleep(500);
  }

  console.log("资助流程结束");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
