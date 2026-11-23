# Demo video script (under 3 minutes)

Record the website (`npm run dev` in `web/`, or the deployed URL) at 1080p.
Speak slowly; each block is one shot.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Home, top | "When a delivery drone hurts someone, the only flight log belongs to the operator. SkyProof puts every flight on a record nobody can edit, on QoreChain, and pays the victim automatically when a safety rule was broken." |
| 0:15–0:45 | Home → Try it → **Someone below** | "The drone asks a safety check before every take-off, drop and landing. Here a person is under the drop point: the check says No, the drone waits, and drops once they leave. Safe flight, no payout." |
| 0:45–1:10 | **Operator ignores "No"** | "Now the operator drops anyway. That breaks rule four, and the verdict appears the moment it happens. This is the same rules code the watchtower runs." |
| 1:10–1:35 | Flights → open a flight → **Try to edit this record** | "These are real flights on QoreChain testnet. Each part is signed with ML-DSA-87 and sealed with ML-KEM-1024. If I remove one moment, the signature breaks instantly." |
| 1:35–1:55 | Claims → paste the victim address → **Check** | "A victim checks their claim: two paid, two rejected, and the balance is read live from the chain." |
| 1:55–2:30 | Proof → **Verify** on batch 1 → scroll to payouts and fraud | "Every batch of our x/rdk rollup is anchored on QoreChain. The settlement receipt passes six checks live. Payouts are real rollup withdrawals. When a dishonest submitter posted a batch paying itself, QoreChain upheld the fraud proof and slashed its 1,000 QOR bond." |
| 2:30–2:50 | Investigate → load key → open a flight | "Only the investigator and insurer can open a sealed record, here in the browser, and replay it in 3D." |
| 2:50–3:00 | Home, top | "SkyProof: every drone flight, on the record. Built on QoreChain for Build Before Q-Day." |
