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
