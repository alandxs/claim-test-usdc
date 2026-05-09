import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  SOLANA_RPC_URL,
  TARGET_ADDRESS,
  USDC_MINT,
} from "./config.js";
import { accountToKeypair, loadAccounts, loadProgress } from "./storage.js";

const USDC_DECIMALS = 6;

async function main() {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const accounts = loadAccounts();
  const progress = loadProgress();

  let totalSol = 0;
  let totalUsdcRaw = 0n;
  let withUsdc = 0;
  let claimed = 0;
  let funded = 0;
  let consolidated = 0;

  for (const acc of accounts) {
    const kp = accountToKeypair(acc);
    const ata = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey);
    const sol = await connection.getBalance(kp.publicKey);
    totalSol += sol;

    let usdcRaw = 0n;
    try {
      const t = await getAccount(connection, ata);
      usdcRaw = t.amount;
    } catch {
      // no ATA
    }
    if (usdcRaw > 0n) withUsdc++;
    totalUsdcRaw += usdcRaw;

    if (progress[acc.publicKey]?.fundedAt) funded++;
    if (progress[acc.publicKey]?.claimedAt) claimed++;
    if (progress[acc.publicKey]?.consolidatedAt) consolidated++;
  }

  console.log("=== 账户状态 ===");
  console.log(`总账户数：${accounts.length}`);
  console.log(`已资助 SOL：${funded}`);
  console.log(`已记录领取：${claimed}`);
  console.log(`已归集：${consolidated}`);
  console.log(`SOL 总余额：${totalSol / LAMPORTS_PER_SOL}`);
  console.log(
    `USDC 总余额（仍在临时账户内）：${
      Number(totalUsdcRaw) / 10 ** USDC_DECIMALS
    }（${withUsdc} 个账户有余额）`,
  );

  const targetAta = getAssociatedTokenAddressSync(USDC_MINT, TARGET_ADDRESS);
  try {
    const t = await getAccount(connection, targetAta);
    console.log(
      `\n目标地址 ${TARGET_ADDRESS.toBase58()} USDC 余额：${
        Number(t.amount) / 10 ** USDC_DECIMALS
      }`,
    );
  } catch {
    console.log(`\n目标地址 ${TARGET_ADDRESS.toBase58()} 暂无 USDC ATA`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
