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

## Real claims filed from the website (deposit, insurer review, payouts)

Both claims were filed from the website's Claims page by a quantum-safe browser wallet, `qor1teh0d0m9p47mjfzvzjsmxnnssfve4n6eq052f8`.

| Step | Tx |
|---|---|
| The wallet registers its ML-DSA-87 key, with proof of possession. This is needed once before any other transaction from a new account; the website now does it automatically. | `462D04DDEA8190FDA282ABD8EE2A7113D9CCA03121BA3775077105503B21F180` (height 10,687,193) |
| **Claim A** on the cheating flight: 1 QOR deposit and a claim with a photo fingerprint, in one transaction | `3C7988C0DA51607F56A7E37BF770354AC3B49A3BBC232DB883F1BD1F0D5CFDC0` (height 10,687,232) |
| **Claim B** on the people_below flight, where no rule was broken: deposit and claim | `52D911B3178F534724B1D046B60C46C26802A65DD3717D45844757E0A082FEAE` (height 10,687,252) |
| **Batch 5** (the two deposits and two claims). Watchtower: claim A found **B4_OVERRIDE** and paid; claim B found no breach and sent to the insurer | `442C8CD01C48ECED67892751FBC1D2BC3C98E54276A7B2FA17A9C4CE1A06C142` |
| **Insurer decision** from the Insurers page. The photo matched its on-chain fingerprint, and the sealed record opened (98 records, all rules followed). Approved, with the reason stored on chain | `D36A8B260010F82D29713745A3232D7C3E22309D8F3A9EA0D8507AAC8CA55295` (height 10,687,339) |
| **Batch 6** (claim A's 6 QOR payout as qledger withdrawal 2, plus the insurer decision) | `C3CF1BF149EF127C9EF483C2E9B669B2CD05CCBA8BD64E13C2B457CBDDDBBF00` |
| **Batch 7** (claim B's insurer-approved 6 QOR payout as withdrawal 3) | `38C24A0983B1D003B9BDB0895799752A0D21F47752EEA50A35CF62C59C853A3F` |
| **`MsgExecuteWithdrawal`**: 6 QOR (5 QOR payout and the 1 QOR deposit back) to claimant A, batch 6, withdrawal 2 | `B61423716B29A4F88A65F470F72BBE96FC69E35540280F7BB2E62DC4C98C76C8` (height 10,712,245) |
| **`MsgExecuteWithdrawal`**: 6 QOR to claimant B, approved by the insurer, batch 7, withdrawal 3 | `29DA803EF3C78E0CC37E452AC891321C83451BCD553A229A97E5D20DA1D33A4B` (height 10,712,249) |

Batches 5–7 were finalized after the 3,600 s challenge window with no challenge, and all roots matched the watchtower's re-execution. An earlier attempt to file a claim before the key was registered was refused at CheckTx (code 8) and cost no fee.

## A claim on a flight the operator never published ("no record")

Filed from the website's claim form with "my flight isn't listed", naming drone SKY-001 at 13:58 on 25 Nov 2026. No flight was published for that time.

| Step | Tx |
|---|---|
| Claim `SKY-001@2026-11-25T13:58` with the 1 QOR deposit, in one transaction | `600F8148A23CBC6DA9F78491AF3945EA0D58522974265DAD5D9937796329EEAE` (height 10,718,055) |
| **Batch 8** (the claim). Watchtower: the claim stays **open**, still inside the 900-block grace period | `AEFC10AC3C92D30EB2FA9196BB341E758D36F2C3DB883CDD7CECDB15BF65F69E` |
| Watchtower after block 10,718,965: still no record, so the claim goes to **review, marked "no record"** | — |
| **Insurer decision** from the Insurers page (approve: "the operator published no record for that time") | `3A8E927899BCB5CFE1691262C9CE2FB240D5A0A6622184BF8C5E78698D77D744` (height 10,724,163) |
| **Batch 9** (the decision), then the watchtower posts the 6 QOR payout | batch `90DC0B12A94412BC2B1CCC1EE1E865DC8D386308BEE0F356E319ED1DF793C244`, payout `84D7D69CDC5BCDA6570BC13ADD54104598BF9A61C97B38B5D84EFB9D27171784` |
| **Batch 10** (the payout as qledger withdrawal 4), final after the challenge window | `C964F0073F93CC20BF696B4F081B18C29D96D30F48F4812AEC460F9B8248E81D` |
| **`MsgExecuteWithdrawal`**: 6 QOR to the claimant | `5BD4EAA2F8A510240B3F39113838E50CF70EB5E46759600307B6E515BDFC023F` (height 10,726,821) |

Independent audit after this: **5 of 5** pool payouts justified.

## The fleet: two more drones

| Step | Tx |
|---|---|
| SKY-002 registered with its permit (Bandra West, r 2 km, one no-fly zone) | `907513218DC87C87A6785F3F68065FF8ECD6C071E2B659C308F99B1B0C043664` (height 10,725,017) |
| SKY-003 registered with its permit (Andheri East, r 2 km, one no-fly zone) | `4683CC39A1F59D539AC17F369B71BC2811C6A703C64B46B0D6F4A5D53C787C24` (height 10,725,074) |
| Flights `SKY-002-normal-1795605840484` (76 records) and `SKY-003-people_below-1795605920731` (80 records), settled in **batch 11** (30 entries) | `26C5A06F7770F3D3100B50FBF1011B185DDC2846F54542B0A6DC89BEF485F823` |

Website: https://skyproof-qorex.malaysiawest.cloudapp.azure.com
