# AI usage

SkyProof was built with an AI coding assistant (Claude, in Claude Code inside VS Code). This file says what it did, what the team did, and how the work was checked.

## Workflow

1. **Research.** The assistant read the fest rules, prizes and FAQ, the QoreChain docs, and the RDK package's type definitions, then mapped each Protocol Builders requirement to a part of SkyProof ([docs/DESIGN.md](docs/DESIGN.md)).
2. **Check the chain before designing.** It read live testnet state (rdk params, existing rollups, their challenge windows) instead of trusting presets. Example: the `nft` preset lists a 7-day challenge window, but every live `nft` rollup has 3,600 s.
3. **Build in small, tested steps.** Each module came with tests (`npm test`, 29 tests), and each feature was committed and pushed on its own.
4. **Dry run before spending.** `npm run dry-run` runs the whole flow offline with throwaway keys. On-chain messages are simulated before broadcast (`fee: "auto"`), and the costly rollup creation was simulated separately first.
5. **Run on testnet and record every transaction** in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

## What the AI generated

- The TypeScript in `rollup/`: flight records, sealed segments, the six rules, ledger and watchtower logic, the CLI scripts and the tests.
- The design notes, the threat model and this file.

## What the team did

- Chose the problem (drone accident evidence) and the category, from our earlier SkyProof prototype at ETHGlobal Mumbai.
- Decided the trade-offs: a judge-held claims pool for automatic payouts (documented as a trust assumption), two posts per segment to fit ML-DSA-87 signatures under the 6,144-byte post limit.
- Funded and controlled the testnet wallet; the recovery phrase stays in a local, git-ignored `.env` that the assistant never printed.
- Reviewed each step's output on testnet before the next one.

## Bugs the process caught

| Found by | Problem | Fix |
|---|---|---|
| Unit test | A withdrawal to a non-canonical address is a silent no-op on the ledger | Claims from unpayable addresses are refused up front |
| Unit test | A fraud proof is only upheld if the entries hash to the batch's inbox range | Tests and the watchtower use the real inbox commitment |
| First testnet run | The SDK needs the REST endpoint to choose the hybrid sign-bytes form | Pass `rest`; nothing was broadcast before the fix |
| Testnet check | KEM keys come back in base64, so a re-run would have registered them twice | Compare in both encodings |
