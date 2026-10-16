// Call trackTestAccounts(Account) once at the top of any e2e/verify script: every Account.generate() it makes is appended to
// web/src/config/internal-accounts.json so real-user stats exclude it (picked up on the next deploy).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/config/internal-accounts.json");
const script = path.basename(process.argv[1] ?? "script");
export function registerTestAccount(address, label = `e2e: ${script}`) {
  const a = "0x" + String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const j = JSON.parse(readFileSync(FILE, "utf8"));
  if (j.accounts.some((x) => x.address === a)) return;
  j.accounts.push({ address: a, label, added: new Date().toISOString() });
  writeFileSync(FILE, JSON.stringify(j, null, 1));
}
/** Call with the script's own Account class (web and keeper have separate SDK copies). */
export function trackTestAccounts(Account) {
  if (Account.__treeTradeTracked) return;
  const orig = Account.generate.bind(Account);
  Account.generate = (...args) => { const acc = orig(...args); registerTestAccount(acc.accountAddress.toString()); return acc; };
  Account.__treeTradeTracked = true;
}

