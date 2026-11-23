# Deployments (qorechain-diana testnet)

Explorer: https://explore.qore.network · REST: https://api-testnet.qore.host

## Accounts

| Role | Address | Keys on chain |
|---|---|---|
| Operator (rollup creator, submitter) | `qor1xynqax3jn65dekatcxqmfwpyh84xtgzl8y4mmn` | ML-DSA-87 |
| Investigator | `qor1f2esu35fp2kw9nknwweu33knyz80uqhgmdyyr7` | ML-DSA-87, ML-KEM-1024 |
| Insurer | `qor1hcpn88ydjgd94t9tm7rzxkuqnjaprqj57jngej` | ML-DSA-87, ML-KEM-1024 |
| Judge / watchtower | `qor1wys2wftp530gzhmzrrj3gpk4r7r4vkqpg8f3qf` | ML-DSA-87 |
| Victim (demo) | `qor1p8dfxg2mx5sah5mjh34yepunrtc50fp53tj35d` | ML-DSA-87 |

## Setup transactions (23 Nov 2026)

| Step | Tx |
|---|---|
| ML-DSA-87 key, investigator (proof of possession) | `93194BB754289AEDD67E451D282023DE1190E674AE51D7FFF73E105EB76A29AE` |
| ML-DSA-87 key, insurer | `3FCF2EC9FED2D219D113601D9B72EF04FC61B1B4FA3F7FAFC52BF88441DB03D9` |
| ML-DSA-87 key, judge | `1804DE74E794BF6789ADEFAF95AEAA83FDDD8C128D401A96A5780FA85D1982D9` |
| ML-DSA-87 key, victim | `48F51037DAA171B57CD2E786CE7BC87A6B6262D0DBD4BA65E2A0D42C976B7C05` |
| ML-KEM-1024 key, investigator | `F00ECD6B42DA52E72886A2CE4ED42C2A43ED795F4073FC45AB0895B7E2E68DE2` |
| ML-KEM-1024 key, insurer | `737FC81BD915D1460FAFCA7A687E6AEEFE35AE3066F7D5C2A83A940E2A29977B` |

Check a transaction: `curl -s https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/<HASH>`

## Rollup `skyproof-1`

Optimistic settlement, `qledger-v1` execution, based sequencing, layer `skyproof-1`, challenge window 3,600 s.
Read it: `curl -s https://api-testnet.qore.host/qorechain/rdk/v1/rollup/skyproof-1`

| Step | Tx |
|---|---|
| Create rollup (10,000 QOR stake, layer registered) | `5DE80B58367A27C86139306F09D3414C482E9BF12DBB359EA3E389A4693FCC69` |
| Bond the operator as batch submitter (1,000 QOR) | `FEEA80168A1FF204C61394E1D92E5E6B56FC7BB1C1309FB08366D0867D0707D8` |

## First flights, batch and verdicts

| Step | Tx |
|---|---|
| Operator bond: 50 QOR deposited into the claims pool (qledger account) | `834D154E906F992AC691550E8290562801800D627D1CCD1901469637418B5EAA` |
| Drone `SKY-001` registered (ML-DSA-87 key + permit) | `6E83932DFAEBE5635B0B3617893EB00B2DBED9CEF1D39BE3FC6501C2962F6096` |
| Flight `SKY-001-override-1795417202605`, segment 0 body (sealed, 4,652 B) | `56F84E3084655C1443121F49272137FEB21DEE374AD3B301C24DAADFE777B4B3` |
| … segment 0 header (drone-signed, 4,962 B) | `4030CC961E1CE5DF1235A4A7477C7221368C9DD226A163E67C35EFF1B55B3B5C` |
| … segments 1–2 | `707D344C…`, `95815E88…`, `E63160A3…`, `FED804E0…` |
| Claim on the override flight (victim) | `707FF23809C59997E122E5E1C5BA1ACE366A4BBEE1F14A7F26A1B6FD8EA600B8` |
| Flight `SKY-001-normal-1795417254922` (6 posts) and its claim | claim `443C477AA0A60D89959B0437876BF7D690664A7579325C393668A18B52844334` |
| **Batch 0**: 16 inbox entries, anchored under ML-DSA-87 | `23878762E5A651075DF6A898F4FCD187F252ED55A08846ACB78C94D6F9425BF8` |
| Watchtower: batch 0 roots match; override flight judged **B4_OVERRIDE**, payout of 5 QOR posted (pool-signed qledger withdrawal) | `B2889F2668ED25222D69899097AE15245E7DB60C39464B2251718218EB8F9637` |
| Watchtower: normal flight judged clean, claim **rejected** | — |

## Settlement receipt, batch 0

`npm run receipt -- 0` → **VALID (chain mode)**: layer binding, batch state root, anchor on chain, creator authority, ML-DSA-87 signature, chain binding. Anchored at main-chain height 10,600,497. Full receipt: [`rollup/receipts/skyproof-1-batch-0.json`](../rollup/receipts/skyproof-1-batch-0.json).

## Simulated flights (drone simulator + safety gate)

| Step | Tx |
|---|---|
| Flight `SKY-001-people_below-1795418572924`: 98 records, 9 sealed segments; DROP denied twice while a person stood at the drop point, then a fresh ALLOW | claim `C3146A1326D29E703C022D92CF51A7C3318B034BBD1568A46E6168B0D4B3D8C6` |
| Flight `SKY-001-cheating-1795418690032`: 94 records; the operator dropped on a DENY | claim `CB9D07425EC85AFFAE5F32A407B17360EF2811A11DC7ED080E58BFB860E0B2BF` |
| **Batch 2**: 36 inbox entries, anchored under ML-DSA-87 | `5C9CDF18C9D5E1068616A63C8360A876918EBABDB8B50CAC60B17839D0BFB1AB` |
| Watchtower: people_below judged clean, claim **rejected**; cheating judged **B4_OVERRIDE**, 5 QOR payout posted | `91F30004C96865B2CED39620062C7DBF8634F6F645363F3248D43F1E4EC9AC31` |

Cost of the two flights with their 36 posts: about 4.2 test QOR in fees.

## Withdrawals executed on QoreChain

| Step | Tx |
|---|---|
| **Batch 1** (the override flight's payout as a qledger WITHDRAW), anchored under ML-DSA-87 | `0386DE01FBA814443B7B62FCDA002829B039E2EC5B9B143B63F1A13126BB6949` |
| Batch 1 finalized after the 3,600 s challenge window, no challenge | — |
| **`MsgExecuteWithdrawal`**: 5 QOR from the rollup escrow to the victim (event `rdk_withdrawal_executed`, batch 1, withdrawal 0) | `2C6A0DDBC423727AEA71D1315E99D01CB7CABD1D46674119CDC0F80856767FB2` |
| **Batch 3** (the cheating flight's payout) | `1C060C7E2040357CD48264FE984E570E1595C6221B0F881BFE8C1DF0D522792E` |
| **`MsgExecuteWithdrawal`**: second 5 QOR payout to the victim (batch 3, withdrawal 1) | `B3DDADBFFAE7E44F612C8AB6666ADAF8E4FA75B9DB5F19B0BB5CC1BF51BE7CF6` |

## Fraud demo: a rogue submitter tries to steal the pool

| Step | Tx |
|---|---|
| Rogue account `qor1lr28nffapg7gp4e68jspr0t2che3hmmxq3npq4` bonds 1,000 QOR as a second submitter | `DBE0FEA74961E30886556760FBFC8F8A69D52F1B493F3338976FD24FC76A0884` |
| Rogue submits **batch 4** whose withdrawals root pays the whole 40 QOR pool to itself | `44692DFAB47CE0874691B84F5607275DC93CE52C91BDAEEAE4229F634A1147E0` (height 10,604,063) |
| **Fraud upheld on chain**, 8 blocks later: event `rdk_fraud_upheld`, rogue bond slashed 1,000 QOR (500 burned, 500 to the challenger), inbox rolled back | `F1FC67BAD31F2DDB…` (height 10,604,071), challenger `qor1axgklr83mx8y0aluc5vgqrpw7uktwq7cu5nnhp` |
| Our watchtower re-executed batch 4 and found the same fraud ("withdrawals root is wrong"); its challenge came after the batch was already rejected, so it was refused in simulation (no cost) | — |
| Our watchtower rewound to the state before batch 4; the operator settled an honest **batch 4** in its place, roots match | `B6AE82B277B6037DFE84791CDE7C416455F1F1E9F87CEBF69DDE739C02D4A369` |

What this shows: a batch that lies about withdrawals cannot steal from the pool on QoreChain. Another watcher on the network won the race to challenge it, so the watchtower's loop now polls every 6 s instead of 30 s.
