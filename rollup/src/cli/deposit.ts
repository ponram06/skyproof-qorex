/** The operator deposits its drone bond into the claims pool on the rollup ledger. Usage: deposit [QOR] */
import { connect, txLine } from "../chain.js";
import { ROLLUP_ID } from "../config.js";
import { poolKey } from "../keys.js";

const qor = BigInt(process.argv[2] ?? "50");

async function main() {
  const op = await connect("operator");
  const pool = poolKey();
  txLine(
    `deposited ${qor} QOR into the claims pool`,
    await op.rdkTx.depositToRollup({ rollupId: ROLLUP_ID, account: pool.accountId, amount: qor * 1_000_000n }, { fee: "auto" }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
