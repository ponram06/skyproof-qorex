# SkyProof Rollup: design

Category: **Protocol Builders** — "a rollup or sidechain with settlement verification, monitoring and confidential data".

## Requirement map

| Requirement | How SkyProof meets it | Shown by |
|---|---|---|
| ML-DSA-signed batches | Every settlement batch carries the rollup creator's ML-DSA-87 `anchor_signature`, so the chain anchors it in x/multilayer in the same tx | `MsgSubmitBatch` txs on qorechain-diana |
| Withdrawal | Victim payouts and operator bond exits are qledger-v1 `WITHDRAW` txs, paid on L1 with `MsgExecuteWithdrawal` and a Merkle proof | `MsgExecuteWithdrawal` txs |
| Verified settlement receipt | `buildSettlementReceipt` / `verifySettlementReceipt` against live chain state for the batch holding a flight; the website shows each check | receipt JSON + web check |
| Watchtower | Re-executes every batch from the inbox; on a wrong state or withdrawals root it sends `MsgChallengeBatch` with a qledger fraud proof; also runs the flight rules | watchtower log, challenge tx in the demo |
| ML-KEM data protection | Flight records are sealed (ML-KEM-1024 + AES-256-GCM) to the investigator's and insurer's registered KEM keys before they are posted | `MsgRegisterKEMKey` + `MsgPostRollupData` txs |
| Threat model | `docs/THREAT_MODEL.md` | repo |

## Actors and keys

| Actor | Keys |
|---|---|
| Operator (rollup creator + submitter) | secp256k1 + ML-DSA-87 (hybrid L1 txs, batch anchors); ML-DSA-44 qledger account for its bond |
| Drone | ML-DSA-87 key that signs each flight record |
| Investigator / insurer | ML-KEM-1024 key registered on chain (opens sealed records) |
| Watchtower / judge | hybrid L1 key (challenges); ML-DSA-44 qledger key for the claims pool |
| Victim | any qor1 address (withdrawal recipient) |

## Flow

1. **Setup.** Operator creates rollup `skyproof-1` (optimistic, `qledger-v1`, based sequencing), bonds as submitter and deposits the drone bond into the rollup ledger.
2. **Fly.** The drone signs every record (ML-DSA-87). Every 15 s a segment is sealed to the investigator and insurer and posted to the rollup inbox.
3. **Settle.** The submitter executes the inbox with qledger-v1 and submits a batch: state root, inbox range hash, withdrawals root and the ML-DSA-87 anchor signature.
4. **Watch.** The watchtower re-executes each batch. A wrong root is challenged with a fraud proof before the window closes.
5. **Claim.** A victim files a claim for a flight. The judge opens the sealed record, verifies record signatures and the batch receipt, and applies rules B1–B6.
6. **Pay.** On a breach, the payout is a qledger withdrawal to the victim; after finalisation anyone executes it on L1. After a cooldown with no open claim, the operator's bond exits the same way.

## Open questions (to settle this week)

- Who signs the payout withdrawal: a judge-held claims-pool account (simple, trusted judge) vs. operator pre-commitment. Trust assumptions go in the threat model.
- Challenge window length for the demo (`default_challenge_window` is 3600 s on testnet).
