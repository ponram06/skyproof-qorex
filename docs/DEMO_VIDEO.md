# Demo video script (under 3 minutes)

Record the website (`npm run dev` in `web/`, or the deployed URL) at 1080p.
Speak slowly; each block is one shot. Most of it is the **Demo** page, which follows one real flight and checks every step live on QoreChain.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Home, top | "When a delivery drone hurts someone, the only flight log belongs to the operator. SkyProof puts every flight on a record nobody can edit, on QoreChain, and pays the victim when a safety rule was broken." |
| 0:15–0:40 | Demo → **Person below, operator dropped anyway** → step 1 (3D) | "The drone asks a safety check before every take-off, drop and landing. Here a person is under the drop point. The check says No. The operator drops anyway." |
| 0:40–1:05 | Step 2 → **Check on QoreChain** | "Each part of the flight is signed by the drone with ML-DSA-87 and sealed with ML-KEM-1024. This button fetches every part from QoreChain and matches it byte for byte: all eight check out." |
| 1:05–1:20 | Step 3 → **Try to edit the record** | "If anyone edits the record, even the operator, the drone's quantum-safe signature breaks." |
| 1:20–1:50 | Steps 4–6 → **Check the payment** | "The victim filed a claim. The watchtower opened the sealed record and found rule four broken: Respect a No. The victim was paid 5 QOR automatically, and here is the payment confirmed on chain." |
| 1:50–2:10 | Step 7 → **Check the fraud proof** | "When the operator posted a fake batch, the watchtower proved it on chain and QoreChain slashed 1,000 QOR from their bond." |
| 2:10–2:30 | Claims → pick drone SKY-001, set a time on 23 Nov 12:54 | "A victim names the drone and the time; the page finds the flight that was in the air. If the operator hid the flight, 'my flight isn't listed' still works: after 30 minutes with no record, the insurer decides. A 1 QOR deposit makes false claims cost money." |
| 2:30–2:50 | Proof → Independent payout audit | "Only the watchtower holds the pool key, so a separate program rebuilds everything from the chain and checks every payout was owed. Four of four are justified." |
| 2:50–3:00 | Home, top | "SkyProof: every drone flight, on the record. Built on QoreChain for Build Before Q-Day." |
