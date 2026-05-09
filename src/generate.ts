import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { ACCOUNT_COUNT } from "./config.js";
import { saveAccounts, type StoredAccount, pathOf } from "./storage.js";

function main() {
  const accounts: StoredAccount[] = [];
  for (let i = 0; i < ACCOUNT_COUNT; i++) {
    const kp = Keypair.generate();
    accounts.push({
      index: i,
      publicKey: kp.publicKey.toBase58(),
      secretKey: bs58.encode(kp.secretKey),
    });
  }
  saveAccounts(accounts);
  console.log(`已生成 ${accounts.length} 个账户，写入 ${pathOf("accounts")}`);
  console.log("提示：data/accounts.json 含私钥，请妥善保管，不要上传 git");
}

main();
