# Squads V3 Rotation

A local browser tool for reviewing and proposing member and threshold changes to an existing Squads v3 multisig on Solana Mainnet.

**Configure -> Review -> Submit.** Connect Phantom (including a Ledger account), load your multisig, enter the complete desired roster and threshold, review the exact changes and local rehearsal, then explicitly approve each wallet transaction. Proposal history supports uploads, approvals and a separate execution after the current quorum is reached.

## Run

Install Node.js 22 or newer (24 recommended), then:

```bash
git clone https://github.com/gcitizen42/squads-v3-rotation.git
cd squads-v3-rotation
npm ci --ignore-scripts
npm run setup
npm test
npm start
```

Open **http://127.0.0.1:8774/** in Brave/Chrome with Phantom. Keep the terminal running; Ctrl+C stops the server. If the port is occupied, use `PORT=8775 npm start` and open that port.

Setup downloads the hash-pinned public Squads program from Solana RPC and runs a synthetic local rehearsal. It does not connect a wallet, sign or submit. Public RPC can rate-limit; setup fails safely rather than using an unverified program.

## Use

1. **Configure:** load the multisig CONFIG address, not its asset vault. Connect a current member's Phantom/Ledger account. Nonmembers are read-only until their addition executes on chain.
2. Enter the complete final member list, one public address per line, and the desired threshold.
3. **Review Rotation:** check the target multisig, additions/removals, final roster, old/new quorum, rent and local rehearsal.
4. **Prepare Submission**, tick the acknowledgement, then **Review And Send In Wallet**. Review every Phantom/Ledger prompt.
5. Resume further packets and approvals in **Proposal History**. Execute separately only after the CURRENT quorum is met. Submission is not execution.

## Limits And Safety

- Only the pinned legacy Squads v3 deployment on Solana Mainnet. Not Squads v4, arbitrary calls, transfers or vault creation.
- 2-32 on-curve members, subject to atomic transaction-size limits. The proposer must remain in the final roster.
- No private keys or seeds required. No server-side signing or broadcast API. Server binds loopback and requires same-origin local preparation requests.
- Editing the address, roster or wallet clears pending signing authorization. Stale configurations, competing proposals and payload mismatches block progress.
- Normal Solana fees and account rent apply. Native-wallet receipt checks happen after broadcast; inspect actual fees before approval. No automatic resend after uncertain delivery.
- Only matching locally prepared proposals receive signing controls. Back up `outputs/desired-plans/` privately when moving your installation.
- Synthetic fixtures are for tests only: **never fund their addresses**. Live drafts, receipts, signatures, logs and credentials are not included in this repository and are gitignored.
- Not audited. Legacy dependency advisories remain. A local VM rehearsal does not prove physical Ledger access or production safety.

## Development

`npm test` runs backend, actual-program VM and receipt checks without real transactions. Optional browser tests:

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:ui
```

Browser tests use synthetic ephemeral wallets and mocked RPC. They do not use a real browser profile or funds.

See [SECURITY.md](SECURITY.md) and [THIRD_PARTY.md](THIRD_PARTY.md).
