# Evidence: every step on QoreChain testnet

One row per step of SkyProof's life cycle, in order. Each link opens the
transaction as JSON from QoreChain's public testnet API (`qorechain-diana`), so it
can be checked in a browser without installing anything. Full details, including
every flight post, are in [DEPLOYMENTS.md](DEPLOYMENTS.md).

Rollup `skyproof-1`: [live state](https://api-testnet.qore.host/qorechain/rdk/v1/rollup/skyproof-1) · qledger-v1, optimistic, challenge window 3,600 s.

| # | Step | What it proves | Tx |
|---|---|---|---|
| 1 | Create rollup `skyproof-1` (10,000 QOR stake) | The rollup is real and registered on QoreChain | [`5DE80B58…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/5DE80B58367A27C86139306F09D3414C482E9BF12DBB359EA3E389A4693FCC69) |
| 2 | Bond the operator as batch submitter (1,000 QOR) | The submitter has money at stake | [`FEEA8016…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/FEEA80168A1FF204C61394E1D92E5E6B56FC7BB1C1309FB08366D0867D0707D8) |
| 3 | Register ML-KEM-1024 keys (investigator, insurer) | Sealed records can only be opened by these two | [`F00ECD6B…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/F00ECD6B42DA52E72886A2CE4ED42C2A43ED795F4073FC45AB0895B7E2E68DE2) · [`737FC81B…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/737FC81BD915D1460FAFCA7A687E6AEEFE35AE3066F7D5C2A83A940E2A29977B) |
| 4 | Operator deposits a 50 QOR bond into the claims pool | Victims are paid from the operator's own money | [`834D154E…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/834D154E906F992AC691550E8290562801800D627D1CCD1901469637418B5EAA) |
| 5 | Register drone `SKY-001` (ML-DSA-87 key + permit) | Only this drone's signature counts for its flights | [`6E83932D…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/6E83932DFAEBE5635B0B3617893EB00B2DBED9CEF1D39BE3FC6501C2962F6096) |
| 6 | Flight segment: sealed body (ML-KEM-1024) and drone-signed header (ML-DSA-87) | The flight record is on chain, private and tamper-evident | [`56F84E30…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/56F84E3084655C1443121F49272137FEB21DEE374AD3B301C24DAADFE777B4B3) · [`4030CC96…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/4030CC961E1CE5DF1235A4A7477C7221368C9DD226A163E67C35EFF1B55B3B5C) |
| 7 | **Batch 0** anchored under the creator's ML-DSA-87 signature | ML-DSA-signed batches | [`23878762…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/23878762E5A651075DF6A898F4FCD187F252ED55A08846ACB78C94D6F9425BF8) |
| 8 | **Settlement receipts** for all 12 batches: 6 of 6 checks against live chain state | Verified settlement receipt | [`rollup/receipts/`](../rollup/receipts) · `npm run receipt -- all` |
| 9 | Claim filed from the website (1 QOR deposit + photo fingerprint, one tx) | Anyone can claim from a browser with a quantum-safe wallet | [`3C7988C0…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/3C7988C0DA51607F56A7E37BF770354AC3B49A3BBC232DB883F1BD1F0D5CFDC0) |
| 10 | Watchtower re-executes, judges the flight **B4_OVERRIDE**, posts the payout | Watchtower + automatic judging | [`442C8CD0…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/442C8CD01C48ECED67892751FBC1D2BC3C98E54276A7B2FA17A9C4CE1A06C142) |
| 11 | **`MsgExecuteWithdrawal`**: 6 QOR to the victim after the challenge window | Withdrawal executed on L1 | [`B6142371…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/B61423716B29A4F88A65F470F72BBE96FC69E35540280F7BB2E62DC4C98C76C8) |
| 12 | Insurer decision (signed, reason on chain) on a claim with no broken rule | Human review for what rules can't settle | [`D36A8B26…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/D36A8B260010F82D29713745A3232D7C3E22309D8F3A9EA0D8507AAC8CA55295) |
| 13 | **`MsgExecuteWithdrawal`**: 6 QOR paid on the insurer's approval | Reviewed claims pay out the same way | [`29DA803E…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/29DA803EF3C78E0CC37E452AC891321C83451BCD553A229A97E5D20DA1D33A4B) |
| 14 | Claim on a flight the operator **never published**, approved after the 900-block grace period | Hiding the record does not avoid payment | [`600F8148…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/600F8148A23CBC6DA9F78491AF3945EA0D58522974265DAD5D9937796329EEAE) → [`3A8E9278…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/3A8E927899BCB5CFE1691262C9CE2FB240D5A0A6622184BF8C5E78698D77D744) → [`5BD4EAA2…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/5BD4EAA2F8A510240B3F39113838E50CF70EB5E46759600307B6E515BDFC023F) |
| 15 | **Fraud**: a rogue batch tries to pay the whole pool to itself | — | [`44692DFA…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/44692DFAB47CE0874691B84F5607275DC93CE52C91BDAEEAE4229F634A1147E0) |
| 16 | Fraud upheld 8 blocks later: rogue bond slashed 1,000 QOR, inbox rolled back | The pool cannot be stolen | [`F1FC67BA…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/F1FC67BAD31F2DDB64614895976A1DE3741444A1A2D23DF7B2F1D50FC2928ABC) |
| 17 | Honest batch 4 settled in its place; roots match the watchtower | The rollup recovers after fraud | [`B6AE82B2…`](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/B6AE82B277B6037DFE84791CDE7C416455F1F1E9F87CEBF69DDE739C02D4A369) |
| 18 | Independent audit rebuilds every pool payout from the chain | Every payout was owed: **5 of 5** | `cd rollup && npm run audit` · website, Proof page |

Attacks that are refused, with tests and transactions: [ATTACKS.md](ATTACKS.md).
