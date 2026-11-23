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
