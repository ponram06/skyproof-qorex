# Attacks SkyProof refuses

Each row is an attack someone might try, what stops it, and the proof: a unit test
(`cd rollup && npm test`, runs on every push in CI) and, where it happened on the
qorechain-diana testnet, the transaction.

| # | Attack | What stops it | Proof |
|---|---|---|---|
| 1 | **Steal the claims pool** with a batch whose withdrawals pay the attacker | Watchers re-execute every batch; the wrong withdrawals root is a fraud proof on QoreChain | On chain: rogue batch 4 [`44692DFA…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/44692DFAB47CE0874691B84F5607275DC93CE52C91BDAEEAE4229F634A1147E0), fraud upheld 8 blocks later, 1,000 QOR bond slashed [`F1FC67BA…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/F1FC67BAD31F2DDB64614895976A1DE3741444A1A2D23DF7B2F1D50FC2928ABC). Test: *the watchtower catches a batch that pays itself and builds a winning fraud proof* |
| 2 | **Forge a flight record** (sign it with another key) | Every segment header must carry the registered drone's ML-DSA-87 signature | Test: *a header signed by another key is rejected* |
| 3 | **Edit a flight record** after the fact | The signed header commits to the sealed body's hash | Tests: *an edited header no longer verifies*, *a body swapped under a signed header is caught* |
| 4 | **Delete the embarrassing part** of a flight | Segments are hash-chained; a gap breaks the chain, and a withheld segment counts against the operator (B5) | Tests: *a deleted record breaks the chain*, *a withheld segment counts against the operator (B5)* |
| 5 | **Never publish the flight at all** | A claim with no record goes to the insurer after 900 blocks, marked "no record" | On chain: insurer approval [`3A8E9278…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/3A8E927899BCB5CFE1691262C9CE2FB240D5A0A6622184BF8C5E78698D77D744), payout [`5BD4EAA2…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/5BD4EAA2F8A510240B3F39113838E50CF70EB5E46759600307B6E515BDFC023F). Test: *a claim on a flight with no record waits, then goes to the insurer marked missing* |
| 6 | **Register a drone in someone else's name** to frame them | Only the rollup operator's registrations count | Test: *a drone registered by someone else is ignored* |
| 7 | **Reuse one approval** for two drops, or use a stale one | Rule B3: each approval is single-use and expires | Tests: *B3: one approval used twice*, *B3: a stale approval* |
| 8 | **Ignore the safety check's "No"** | Rule B4: acting after a DENY is a breach, paid automatically | On chain: payout [`2C6A0DDB…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/2C6A0DDBC423727AEA71D1315E99D01CB7CABD1D46674119CDC0F80856767FB2). Test: *an override: the victim is paid from the pool* |
| 9 | **Spam false claims** for free | Each claim needs a 1 QOR deposit, kept if the claim is false | Tests: *a new claim without its 1 QOR deposit is refused*, *the insurer rejects a false claim…* |
| 10 | **Back a claim with someone else's deposit**, or one deposit for many claims | A deposit must go to the pool account and backs exactly one claim | Tests: *a deposit to some other account does not back a claim*, *one deposit backs one claim* |
| 11 | **Get paid twice** for the same claim | Each claim is paid once, across claims and across watchtower rounds | Tests: *attack: filing the same claim twice, with two deposits, is paid once*, *attack: a paid claim is not paid again…* |
| 12 | **Fake an insurer decision** | Only the insurer's address can decide, and only claims in review | Test: *only the insurer can decide, and only a claim in review* |
| 13 | **Flip a rejected claim** with a second decision | The first decision is final | Test: *attack: a second insurer decision cannot flip a rejected claim into a payout* |
| 14 | **Read sealed flight data** without being a recipient | Records are sealed with ML-KEM-1024 to the investigator and insurer only | Test: *someone who is not a recipient cannot open the records*; try a wrong code on the website's Investigate page |
| 15 | **Sign a payout with the wrong key** | qledger checks the pool's ML-DSA-44 signature | Test: *a payout signed by the wrong key moves nothing* |
| 16 | **Pay out to an unpayable or malformed address** | Claims with an address the ledger can't pay are refused up front | Tests: *a claim from an address the ledger cannot pay is refused up front*, *…an unpayable one is refused* |
| 17 | **Crash the watchtower** with junk posts | Malformed posts are skipped and logged | Test: *malformed posts are ignored, not fatal* |
| 18 | **Withdraw the operator's bond** while claims are open | The bond exit waits until every open or in-review claim is settled | Tests: *a bond exit waits for open claims…*, *a bond exit waits while a claim is in review* |
| 19 | **Pay more than was owed** | An independent audit matches each pool withdrawal to a judged claim | `npm run audit`: 5 of 5 payouts justified. Test: *the audit … flags one that wasn't* |

Known limits are in [THREAT_MODEL.md](THREAT_MODEL.md).
