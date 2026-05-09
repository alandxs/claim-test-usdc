import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const DATA_DIR = path.resolve(process.cwd(), "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PROGRESS_FILE = path.join(DATA_DIR, "progress.json");

export interface StoredAccount {
  index: number;
  publicKey: string;
  secretKey: string; // base58
}

export interface ProgressMap {
  // key 为 publicKey
  [publicKey: string]: {
    fundedAt?: string;
    claimedAt?: string;
    claimError?: string;
    consolidatedAt?: string;
    consolidatedSig?: string;
  };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function saveAccounts(accounts: StoredAccount[]): void {
  ensureDir();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf8");
}

export function loadAccounts(): StoredAccount[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error(
      `${ACCOUNTS_FILE} 不存在，请先运行 npm run generate 生成账户`,
    );
  }
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")) as StoredAccount[];
}

export function accountToKeypair(acc: StoredAccount): Keypair {
  return Keypair.fromSecretKey(bs58.decode(acc.secretKey));
}

export function loadProgress(): ProgressMap {
  ensureDir();
  if (!fs.existsSync(PROGRESS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")) as ProgressMap;
  } catch {
    return {};
  }
}

export function saveProgress(progress: ProgressMap): void {
  ensureDir();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
}

export function updateProgress(
  publicKey: string,
  patch: ProgressMap[string],
): ProgressMap {
  const progress = loadProgress();
  progress[publicKey] = { ...(progress[publicKey] ?? {}), ...patch };
  saveProgress(progress);
  return progress;
}

export function pathOf(file: "accounts" | "progress"): string {
  return file === "accounts" ? ACCOUNTS_FILE : PROGRESS_FILE;
}
