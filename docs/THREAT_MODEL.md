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
| Investigator, insurer | ML-KEM-1024 keys; the insurer also an ML-DSA-87 account | Reading sealed records; the insurer decides claims the rules sent to review | Moving money: the insurer only posts a decision, the watchtower pays |
| Judge / watchtower | Challenger key, claims-pool ledger key | Applying the public rules B1–B6 and signing payouts | — its verdicts are reproducible (below) |
| Victim | A qor1 address (the website creates one in the browser) | Filing a claim with a 1 QOR deposit | Telling the truth: a claim with no breach goes to the insurer |
| Anyone | — | Re-checking batches, receipts and verdicts | — |

## Threats and mitigations

### Against the record

| Threat | Mitigation | Where |
|---|---|---|
| Operator edits a record after the flight | Records are hash-chained; each segment's head hash is signed by the drone (ML-DSA-87) and posted on chain. An edited record changes the head, so the signature and the chain both fail. | `flight/record.ts`, `flight/segment.ts` |
| Operator swaps a whole segment body | The signed header commits to the SHA-256 of the sealed body post. | `openSegment` |
| Operator deletes or reorders records | Sequence numbers and the hash chain; segment headers chain through `prev`. | `checkChain`, `judgeFlight` |
| Operator withholds a segment or never closes the flight | Counted as a breach (B5): a record the operator cannot produce intact counts against the operator. | `judgeFlight`, rule B5 |
| Operator withholds a whole flight | A victim can claim by drone ID and time without picking a published flight. If no record of the claimed flight is published within 900 blocks (~30 min) of the claim, it goes to the insurer marked "no record", so hiding a flight never ends the claim. | `decide`, `RECORD_GRACE_BLOCKS` |
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
| Claim spam and false claims | Every claim must carry a 1 QOR deposit into the claims pool, in the same transaction; one deposit backs one claim, and one claim per victim per flight. A claim with a breach gets its deposit back with the payout; a claim the insurer rejects as false loses it. Plus the posting fee (10 uqor per byte, plus gas). | `readPosts`, `decide` |
| A fake insurer decision | Decisions count only from the insurer's address (hybrid ML-DSA-87 signed tx), only for a claim in review, and only once. | `readPosts` |
| Forged photo evidence | Only the photo's SHA-256 goes on chain at filing time; the insurer checks the photo the victim shows them against it, so it can't be swapped later. | website, Insurers page |
| Operator drains its bond before claims are judged | A bond exit is paid only when no claim is open or with the insurer, and never beyond the pool balance. | `decide` |
| Someone blocks the operator's bond exit forever with a claim on a flight that doesn't exist | That claim reaches the insurer after the 30-minute grace period, and the insurer's decision closes it; a false one loses its deposit. | `decide` |
| The judge pays out money nobody was owed | The independent payout audit rebuilds the judge's view from the chain alone and matches every pool withdrawal to a paid claim or a bond exit; an unmatched one is flagged on the website. This detects, it does not prevent (see assumption 1). | `audit.ts`, `npm run audit` |
| A fake settlement receipt | `verifySettlementReceipt` re-reads every field from chain state: the anchor, the creator's registered ML-DSA-87 key and the chain id. | `cli/receipt.ts` |

## Trust assumptions we accept

1. **The judge holds the claims-pool key.** The judge could refuse to pay or pay wrongly. qledger-v1 accounts take a single ML-DSA-44 key, with no multi-signature, so today nothing on chain can stop a dishonest judge. What bounds it: the rules are public, deterministic code (`rules.ts`); every input is on chain; and the independent payout audit (`npm run audit`) re-derives what was owed and flags any payout that matches nothing. The audit found all 4 testnet payouts justified. The production fix is a multi-signature or threshold pool account, so that two independent judges must agree before money moves.
2. **The investigator and insurer can read the records.** By design. A record sealed to nobody could not be judged.
3. **The insurer judges claims with no breach.** A human decision is needed when the signed record shows no broken rule but someone may still have been hurt. It is signed and public, with its reason, and it can only pay or refuse a claim the rules sent to review: it cannot touch claims the rules decided.
4. **One mnemonic derives every demo role.** This lets one person run the demo. In production each role holds its own secret.

## Known limits (stated plainly)

- **In the demo, the operator can produce the drone's signing key.** Every demo key, including the drone's ML-DSA-87 key, is derived from one mnemonic that the operator runs. So in the demo the operator *could* sign a made-up "clean" record. The signatures prove the record was not edited after signing; they cannot prove who held the key. In production the drone key must be generated and kept inside a secure element on the drone, which signs records but never exports the key. The operator registers its public key (as today), and the drone maker attests that it lives in hardware.
- **Sensor honesty.** The record proves what the drone recorded and decided, not that its GPS, wind sensor or camera told the truth. A spoofed GPS produces a validly signed false track. Defences beyond this project: tamper-resistant sensors, and cross-checking the track against independent Remote ID receivers (drones must broadcast their ID and position in many countries).
- **Finding the flight relies on the drone's ID.** The victim names the drone (painted ID or Remote ID broadcast) and the time. A victim who saw no ID can still claim "my flight isn't listed", but then the insurer has less to go on.
- **The location in a claim is the victim's word** until the insurer opens the sealed record and compares it with the drone's position log. The watchtower's six rules don't check it.
- **A compromised drone key** signs whatever the attacker wants. Mitigation in production: keys in a secure element, rotation with `MsgRotatePQCKey`.
- **Liveness.** If the watchtower is offline for a whole challenge window (3,600 s on testnet), a fraudulent batch can finalise. Anyone can run a watchtower; more than one should.
- **Withdrawals wait for finalisation** (one challenge window) before they can be executed on QoreChain.
