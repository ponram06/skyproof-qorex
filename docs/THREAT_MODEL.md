# SkyProof Rollup: threat model

What SkyProof protects, who might attack it, and what stops them. Code references point at `rollup/src/`.

## What we protect

| Asset | Why it matters |
|---|---|
| The flight record | The only evidence of what an autonomous drone did. It must not be edited, reordered, deleted or withheld after the fact. |
| Its confidentiality | Records hold positions, camera-derived decisions and timings. Only the investigator and the insurer may read them. |
| The claims pool | Operator bonds that pay victims. Money must move only for a breach, and only to the victim. |
| The settlement state | Batch roots on QoreChain decide every payout and bond exit. |

## Actors and what we trust them with

| Actor | Holds | Trusted for | Not trusted for |
|---|---|---|---|
| Drone | ML-DSA-87 signing key | Signing what its sensors and safety model reported | — (sensor honesty is out of scope, see Limits) |
| Operator | Rollup creator + submitter key, drone bond | Posting flights and batches | Telling the truth: every post and batch is checked |
| Investigator, insurer | ML-KEM-1024 keys | Reading sealed records | Moving money |
| Judge / watchtower | Challenger key, claims-pool ledger key | Applying the public rules B1–B6 and signing payouts | — its verdicts are reproducible (below) |
| Victim | Any qor1 address | Filing a claim | — |
| Anyone | — | Re-checking batches, receipts and verdicts | — |

## Threats and mitigations

### Against the record

| Threat | Mitigation | Where |
|---|---|---|
| Operator edits a record after the flight | Records are hash-chained; each segment's head hash is signed by the drone (ML-DSA-87) and posted on chain. An edited record changes the head, so the signature and the chain both fail. | `flight/record.ts`, `flight/segment.ts` |
| Operator swaps a whole segment body | The signed header commits to the SHA-256 of the sealed body post. | `openSegment` |
| Operator deletes or reorders records | Sequence numbers and the hash chain; segment headers chain through `prev`. | `checkChain`, `judgeFlight` |
| Operator withholds a segment or never closes the flight | Counted as a breach (B5): a record the operator cannot produce intact counts against the operator. | `judgeFlight`, rule B5 |
| Someone registers a fake drone or forges headers | Drone registrations count only from the rollup's creator; headers need the registered drone's ML-DSA-87 signature. | `readPosts` |
| A quantum adversary forges the drone's or operator's signature | ML-DSA-87 (FIPS 204, NIST level 5) for drone headers, batch anchors and every native transaction (hybrid with secp256k1). | `@qorechain/sdk` hybrid signing |

### Against confidentiality

| Threat | Mitigation |
|---|---|
| The public reads flight data from the inbox | Bodies are sealed with ML-KEM-1024 + AES-256-GCM to the investigator's and insurer's keys; the chain only sees ciphertext. |
| Harvest now, decrypt later | ML-KEM-1024 is post-quantum; a stored ciphertext stays closed after Q-Day. |
| Sealing to a key the recipient does not control | Recipients register their ML-KEM keys on chain (`MsgRegisterKEMKey`) from their own accounts, which already have ML-DSA-87 keys with proof of possession. |

### Against the money

| Threat | Mitigation | Where |
|---|---|---|
| Submitter publishes a batch that pays itself or skips a payout | Optimistic settlement with qledger-v1: the watchtower re-executes every batch and sends a fraud proof the chain re-checks; the dishonest submitter's bond is slashed. | `ledger.ts` `checkBatch`, `cli/watchtower.ts` |
| A forged payout | Pool payouts are qledger `WITHDRAW` txs that need the pool's ML-DSA-44 signature; any other key moves nothing (tested). | `ledger.test.ts` |
| A payout to an address that can never receive it | Claims from non-canonical addresses are refused up front (such a withdrawal is a no-op on chain). | `readPosts` |
| Claim spam | Every claim is an on-chain post the claimant pays for (10 uqor per byte, 1 KiB minimum, plus gas). One claim per victim per flight. | `readPosts` |
| Operator drains its bond before claims are judged | A bond exit is paid only when no claim is open, and never beyond the pool balance. | `decide` |
| A fake settlement receipt | `verifySettlementReceipt` re-reads every field from chain state: the anchor, the creator's registered ML-DSA-87 key and the chain id. | `cli/receipt.ts` |

## Trust assumptions we accept

1. **The judge holds the claims-pool key.** The judge could refuse to pay or pay wrongly. This is the price of automatic payouts in a ledger where only key holders move funds. It is bounded: the rules are public, deterministic code (`rules.ts`), every input is on chain, and anyone holding a recipient key can re-run a verdict and prove the judge wrong. A production version would split the pool key across several judges (threshold signing).
2. **The investigator and insurer can read the records.** By design. A record sealed to nobody could not be judged.
3. **One mnemonic derives every demo role.** This lets one person run the demo. In production each role holds its own secret.

## Out of scope / limits

- **Sensor honesty.** The record proves what the drone recorded and decided, not that its GPS or camera told the truth. Tamper-resistant hardware is the next layer.
- **A compromised drone key** signs whatever the attacker wants. Mitigation in production: keys in a secure element, rotation with `MsgRotatePQCKey`.
- **Liveness.** If the watchtower is offline for a whole challenge window (3,600 s on testnet), a fraudulent batch can finalise. Anyone can run a watchtower; more than one should.
- **Withdrawals wait for finalisation** (one challenge window) before they can be executed on QoreChain.
