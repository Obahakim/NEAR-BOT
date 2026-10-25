# NEAR-BOT

TypeScript CLI agent for **NEAR testnet**. On setup it can **create its own account** (implicit account + keypair), **encrypt the private key with your password**, and only **reveal the key when the correct password is entered**. Optional **[ASGUARD](https://github.com/Obahakim/ASGUARD)** pre-sign approval before transfers.

ASGUARD does **not** hold private keys. This agent signs locally after approval (or with the gate disabled for local dev).

## Requirements

- Node.js 20+
- Optional: ASGUARD on `http://localhost:8080` with a runtime API token

You do **not** need an existing NEAR key to start. Setup generates one.

## Install

```bash
git clone https://github.com/Obahakim/NEAR-BOT.git
cd NEAR-BOT/near-agent
npm install
cp .env.example .env
```

## Create a new agent wallet

```bash
npm run setup
```

Choose **new** (default):

1. Enter a password (min 8 characters) twice  
2. Agent generates an ed25519 keypair  
3. Account id = NEAR **implicit account** (64-char hex of the public key)  
4. Private key is stored **encrypted** in `agent-keystore.json`

Fund the account on testnet (faucet), using the printed account id as recipient. Implicit accounts become active when first funded — no separate create-account tx.

### Import an existing key (optional)

```bash
npm run setup
# mode: import
```

### Reveal private key

```bash
npm start -- reveal
```

Enter the password. Wrong password → key is not revealed.

## Commands

```bash
npm start                 # menu
npm run setup             # new or import
npm start -- reveal
npm start -- balance      # asks password
npm start -- send <to> 0.01
npm run status
```

## ASGUARD flow

1. Unlock keystore with password  
2. Build transfer intent + `payload_hash`  
3. `POST /api/approvals/sign-request` (`chain: near`, `network: testnet`)  
4. On approve, sign and broadcast locally  

Set `ASGUARD_ENABLED=false` only for offline debugging.

## Security

- Private key is encrypted (scrypt + AES-256-GCM); plaintext only in memory after password unlock  
- Never commit `agent-keystore.json` or `.env`  
- Prefer testnet for demos  
