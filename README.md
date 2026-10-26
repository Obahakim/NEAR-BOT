# NEAR-BOT

TypeScript CLI agent for **NEAR testnet**:

- Generates its own **implicit account** and encrypts the private key with your password
- **ASGUARD** pre-sign gate via **REST and/or MCP**
- **Autonomous** loop: random transfers / wraps every 5–30s until **Ctrl+C**
- On HITL, the agent **waits** for your decision (does not skip)

## Install

```bash
git clone https://github.com/Obahakim/NEAR-BOT.git
cd NEAR-BOT/near-agent
npm install
cp .env.example .env
npm run setup
```

## Runtime token (ASGUARD)

The bot’s `ASGUARD_RUNTIME_TOKEN` is **one of the API tokens** from ASGUARD’s `ASGUARD_API_CREDENTIALS` — specifically the entry whose **roles** include **`runtime`**.

It is **not** a separate system, and it should **not** be the dashboard `admin` / `operator` token.

In ASGUARD `.env`:

```env
ASGUARD_API_CREDENTIALS=[{"id":"runtime-local","token":"YOUR_LONG_RANDOM_RUNTIME_TOKEN","roles":["runtime"]},{"id":"dashboard-local","token":"DIFFERENT_DASHBOARD_TOKEN","roles":["admin","operator","auditor"]}]
```

Generate tokens (32+ bytes):

```bash
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

Put the **runtime** token into NEAR-BOT `.env`:

```env
ASGUARD_RUNTIME_TOKEN=YOUR_LONG_RANDOM_RUNTIME_TOKEN
ASGUARD_TRANSPORT=auto   # auto | rest | mcp
ASGUARD_URL=http://localhost:8080
ASGUARD_MCP_URL=http://localhost:8080/mcp
```

Same token authenticates both `POST /api/approvals/...` and `POST /mcp`.

## Autonomous mode

```bash
npm run autonomous
# or: npm start -- autonomous
```

- Amounts: 0.01–0.1 NEAR (configurable)
- Delay: 5–30 seconds
- Actions: transfers (allowlist / self) + wrap NEAR (`wrap.testnet`)
- **No max runtime** — stop with **Ctrl+C**
- HITL: loop blocks until you approve/deny in ASGUARD (or timeout deny)

## Commands

```bash
npm run setup
npm start -- balance | send | status | reveal | autonomous
```
