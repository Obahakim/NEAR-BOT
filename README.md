# NEAR-BOT

TypeScript CLI agent for **NEAR testnet**. It keeps keys in a local keystore and optionally asks **[ASGUARD](https://github.com/Obahakim/ASGUARD)** for pre-sign approval before any transfer.

ASGUARD does **not** hold private keys. This agent signs only after an approved attestation (or with the gate disabled for local dev).

## Requirements

- Node.js 20+
- A NEAR **testnet** account + `ed25519:` private key
- Optional: ASGUARD running on `http://localhost:8080` with a runtime API token

## Setup

```bash
cd near-agent
npm install
cp .env.example .env
# edit .env — set ASGUARD_RUNTIME_TOKEN if using the gate
npm run setup
```

`setup` writes `near-agent/agent-keystore.json` (gitignored).

Fund the account via a [NEAR testnet faucet](https://near-faucet.io/) if needed.

## Commands

```bash
npm start              # interactive menu
npm run setup          # import account + key
npm run balance
npm run status
npm start -- send <receiver.testnet> 0.01
```

## ASGUARD flow

1. Agent builds a canonical transfer intent and `payload_hash = sha256(intent)`.
2. Calls `POST /api/approvals/sign-request` with `chain: near`, `network: testnet`.
3. On `approved`, verifies attestation `payload_hash` matches.
4. On `pending_hitl`, polls until approved / rejected / timeout (fail closed).
5. Only then signs and broadcasts with the local keystore.

Set `ASGUARD_ENABLED=false` only for offline debugging.

## Security

- Never commit `agent-keystore.json`, `.env`, or private keys.
- Prefer testnet for demos.
- Keep ASGUARD_RUNTIME_TOKEN secret and distinct from dashboard tokens.
