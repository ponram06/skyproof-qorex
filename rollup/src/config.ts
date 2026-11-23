import "dotenv/config";
import { createRdkClient } from "@qorechain/rdk";

export const rdk = createRdkClient({ network: "testnet" });

export const ROLLUP_ID = process.env.SKYPROOF_ROLLUP_ID ?? "skyproof-1";

/** QOR has 6 decimals: 1 QOR = 1,000,000 uqor. */
export const UQOR_PER_QOR = 1_000_000n;

export const toQor = (uqor: bigint | string): string => {
  const v = BigInt(uqor);
  const whole = v / UQOR_PER_QOR;
  const frac = (v % UQOR_PER_QOR).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};
