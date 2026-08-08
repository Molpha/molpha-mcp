# TickerLayer via Molpha MCP

Build the Molpha MCP server from source, connect it to Claude Desktop, and
fetch a BTC/USD price from TickerLayer through Molpha's oracle network (paid
for on the spot via x402, no subscription), settled to Solana.

## Prerequisites

- Git
- Node.js (20+; npm ships with it)
- Claude Desktop
- A Solana wallet funded with devnet SOL and devnet USDC

## 1. Build and connect

Confirm the wallet keypair (`keypair.json`) is already in place and funded, then clone the `tickerlayer` branch, install, and build:

```bash
git clone -b tickerlayer https://github.com/molpha/mcp.git
cd mcp
npm ci
npm run build
```

Check the setup - signer config, wallet, Solana RPC:

```bash
SIGNER_BACKEND=memory OWNER_KEYPAIR=/absolute/path/to/owner-keypair.json npm run doctor
```

Open Claude Desktop's config and add a `molpha` entry inside the existing
`mcpServers` object, pointing at the build you just produced (wherever you
cloned it) and your keypair:

```json
"molpha": {
  "command": "node",
  "args": [
    "/absolute/path/to/mcp/dist/src/server.js"
  ],
  "env": {
    "SOLANA_RPC": "https://api.devnet.solana.com",
    "SIGNER_BACKEND": "memory",
    "OWNER_KEYPAIR": "/absolute/path/to/owner-keypair.json"
  }
}
```

Save the file and restart Claude Desktop so it picks up the new server.

## 2. Fetch and pay

In Claude Desktop's chat:

> Hey, can you fetch the close BTC/USD price through Molpha using the TickerLayer provider, pay for it with x402, and submit the signed result to Solana? Just show me the price it got and the transaction signature.

That one request funds the escrow, signs the payment authorization,
dispatches to the oracle node quorum, and submits the signed result to
Solana - the response includes the price and the transaction signature.

## What the fetch call actually does

Claude uses Molpha's `molpha_fetch_verified` tool, with three things telling
it what to do:

- **Data source** - instead of pointing it at your own API, you name a
  built-in provider (TickerLayer) and what you want from it: BTC/USD's
  previous daily close.
- **Payment** - pays for just this one request by funding a small escrow on
  the spot (x402), instead of requiring a pre-paid subscription.
- **Auto-submit** - once the price is fetched and signed, it's also written
  to Solana in the same call, instead of needing a separate submit step.
