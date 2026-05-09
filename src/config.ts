import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`环境变量 ${name} 未配置，请检查 .env`);
  }
  return value.trim();
}

export const TARGET_ADDRESS = new PublicKey(
  required(
    "TARGET_ADDRESS",
    process.env.TARGET_ADDRESS ?? "Hngd6dHVsmarpmRh3VPtZook7xu1szdysWth8pNKGgnM",
  ),
);

export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";

export const USDC_MINT = new PublicKey(
  process.env.USDC_MINT?.trim() || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

export const ACCOUNT_COUNT = Number.parseInt(
  process.env.ACCOUNT_COUNT?.trim() || "100",
  10,
);

export const SOL_PER_ACCOUNT = Number.parseFloat(
  process.env.SOL_PER_ACCOUNT?.trim() || "0.005",
);

export function loadFunder(): Keypair {
  const raw = required("FUNDER_SECRET_KEY", process.env.FUNDER_SECRET_KEY);
  // 兼容两种格式：base58 字符串 或 JSON 数组（Solana CLI keygen 默认导出）
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}
