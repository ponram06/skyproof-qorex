# SkyProof Rollup

**A post-quantum flight-record rollup for autonomous drones on QoreChain.**

> Status: **work in progress** (started 23 Nov 2026 for QoreChain *Build Before Q-Day*, category **Protocol Builders**).
> This README tracks what exists today; the plan lives in [docs/DESIGN.md](docs/DESIGN.md).

## The problem

When an autonomous drone hurts someone, the only flight log belongs to the operator. It can be edited, lost or withheld, and a classical signature on it stops meaning anything once a quantum computer can forge ECDSA.

## The idea

Every drone flight becomes data in an app-specific **QoreChain rollup** (x/rdk, qledger-v1, optimistic):

- the drone's flight records are **sealed with ML-KEM-1024** to the investigator and insurer, and posted to the rollup inbox;
- each settlement batch is **anchored under an ML-DSA-87 signature**, so anyone can build and check a **settlement receipt** for a flight;
- a **watchtower** re-executes every batch, **challenges** a wrong one with a fraud proof, and checks each flight against the safety rules;
- the operator's bond lives in the rollup ledger: a victim's payout and the operator's bond exit are **withdrawals** executed on QoreChain.

## Progress

| Part | State |
|---|---|
| Design and requirement mapping | drafted |
| `rollup/` preflight (live chain params, costs, keys) | working |
| Rollup creation on qorechain-diana | not yet |
| Sealed flight records (ML-KEM-1024) | not yet |
| Batch submitter with ML-DSA-87 anchors | not yet |
| Watchtower + fraud proofs | not yet |
| Withdrawals (payout, bond exit) | not yet |
| Settlement receipts | not yet |
| Website | not yet |
| Threat model | not yet |

## Run what exists

Needs Node 22+.

```sh
cd rollup
npm install
cp .env.example .env      # optional: add the operator mnemonic to also check its balance and PQC key
npm run preflight
```

## Origin

The idea (a tamper-evident drone black box with automatic payouts) was first prototyped by our team at ETHGlobal Mumbai on other chains. This repository is a new build for QoreChain, written from scratch during the fest.

## Credits

- [`@qorechain/rdk`](https://github.com/qorechain/qorechain-rdk) (Apache-2.0): rollup client, qledger-v1, envelopes, receipts, watchtower helpers.
- [`@qorechain/sdk`](https://github.com/qorechain/qorechain-sdk): accounts and hybrid ML-DSA-87 signing.

## License

[Apache-2.0](LICENSE)
