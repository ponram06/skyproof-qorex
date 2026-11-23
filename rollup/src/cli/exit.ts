/** The operator asks for (part of) its bond back. Paid by the judge once no claim is open. Usage: exit [QOR] */
import { connect, txLine } from "../chain.js";
import { ROLLUP_ID } from "../config.js";
import { exitPost } from "../flight/posts.js";

async function main() {
  const qor = BigInt(process.argv[2] ?? "10");
  const op = await connect("operator");
  txLine(`bond exit of ${qor} QOR requested`, await op.rdkTx.postRollupData({ rollupId: ROLLUP_ID, data: exitPost(qor * 1_000_000n) }, { fee: "auto" }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
