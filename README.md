# blockchainiq-agentkit

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for the
[Blockchain IQ](https://www.blockchainiq.co/agents) x402 crypto data API.
An AgentKit agent can buy Blockchain IQ data one call at a time.
It pays in USDC on Base from its own AgentKit wallet over [x402](https://x402.org) v2.
You don't need an API key or an account.

| Action | Resource | Price | Returns |
| --- | --- | --- | --- |
| `BlockchainIQActionProvider_get_market_brief` | `GET /api/x402/v1/brief` | $0.01 | BTC, ETH, SOL and XRP prices with 24h, 7d and 30d moves and rank, scheduled events in the next 48 h, and risk flags |
| `BlockchainIQActionProvider_get_event_risk` | `GET /api/x402/v1/event-risk` | $0.05 | Scheduled market-moving events for the next 7 days by default (`days` 1–90, `minImportance` 1–3), each with an official source |

Each action returns JSON containing:

- `ok` and `status`
- `data`: the resource's payload
- `settlement`: the decoded `PAYMENT-RESPONSE` header (`transaction`, `network`, `payer`)
- `explorer`: a Basescan link to the settlement transaction

## How a call works

1. The action sends a plain `GET`. Blockchain IQ answers `402` with a `PAYMENT-REQUIRED` header containing the price, the USDC asset, Base `eip155:8453` and the `payTo` address.
2. [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch) with `ExactEvmScheme` signs an EIP-3009 USDC authorization for exactly that amount. It signs with the AgentKit wallet (`walletProvider.toSigner()`) and retries the request with `PAYMENT-SIGNATURE`.
3. Blockchain IQ settles the payment and returns `200` with JSON and a `PAYMENT-RESPONSE` header carrying the transaction hash. The payer needs no ETH because settlement is gasless for the payer.

**Spend cap:** a per-payment cap (`maxUsdPerCall`, default **$0.06**) is enforced by x402 `spendControls`. A price above the cap is refused before anything is signed. A 404 or an error response is never charged.

The provider is only offered on **Base mainnet** wallets (`supportsNetwork`), because Blockchain IQ is paid in USDC on Base only.

## Setup

Requirements:

- Node 18 or later
- A **dedicated** wallet holding a few cents of USDC on Base. Never use a main wallet.

```bash
git clone https://github.com/Duffey234/blockchainiq-x402-agentkit.git
cd blockchainiq-x402-agentkit
npm install
npm test          # offline: mocked 402 + mocked settlement, no wallet, no money
npm run probe     # free: reads the live 402 price terms for brief and event-risk, pays nothing
```

### One real paid call ($0.01)

```bash
export AGENT_PRIVATE_KEY=0x...      # dedicated wallet with >= 0.01 USDC on Base
npm run paid-call                   # brief, $0.01
npm run paid-call -- event-risk     # event-risk, $0.05
```

The command prints the data, the proof of settlement and the Basescan link, for example:

```
payer 0xYourWallet -> BlockchainIQActionProvider_get_market_brief
{ "asOf": "...", "coins": [ ... ], "events": [ ... ], "flags": [ ... ] }

proof of settlement: {"success":true,"transaction":"0x...","network":"eip155:8453","payer":"0xYourWallet"}
transaction: https://basescan.org/tx/0x...
```

If the wallet has no USDC, the facilitator refuses the authorization. You get `payment not accepted: ... (does the paying wallet hold enough USDC on Base?)` and nothing is charged.

## Use it in your agent

```ts
import "reflect-metadata";
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { blockchainIQActionProvider } from "blockchainiq-agentkit";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const walletProvider = new ViemWalletProvider(createWalletClient({ account, chain: base, transport: http() }));

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [blockchainIQActionProvider({ maxUsdPerCall: 0.06 })],
});
```

The provider works with any AgentKit `EvmWalletProvider` on Base mainnet whose `toSigner()` signs EIP-712 typed data as an externally owned account, such as `ViemWalletProvider` or a CDP EVM server wallet. Smart-contract wallets can't sign the EIP-3009 authorization that USDC requires.

The actions plug into the usual AgentKit framework extensions:

- `getLangChainTools(agentkit)` from `@coinbase/agentkit-langchain`
- `getVercelAITools(agentkit)` from `@coinbase/agentkit-vercel-ai-sdk`
- `getMcpTools(agentkit)` from `@coinbase/agentkit-model-context-protocol`

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maxUsdPerCall` | `0.06` | Refuse any single payment above this many dollars |
| `baseUrl` | `https://www.blockchainiq.co/api/x402/v1` | API base (tests) |
| `fetchImpl` | global `fetch` | Inject a fetch (tests) |

## Tests

`npm test` compiles with `tsc` and runs `node --test`. The suite is fully offline:

- **Mocked API.** The mock server replays the **real** `PAYMENT-REQUIRED` headers captured from the live API (`test/fixtures/*.b64`) and returns a fake settlement on the paid retry.
- **Real signing.** A throwaway, unfunded key really signs the EIP-3009 authorization.
- **What the tests check:**
  - Both actions register with AgentKit.
  - The signed payment is x402 v2 `exact` on `eip155:8453`, for USDC, to Blockchain IQ's `payTo`, for exactly 10000 (brief) or 50000 (event-risk) base units, from the wallet's address.
  - `days` and `minImportance` are forwarded, and out-of-range input is rejected before any request.
  - The spend cap refuses a $0.05 call when capped at $0.02, with no signed retry.
  - Server rejections and 5xx errors are surfaced and never paid.
  - The provider is hidden on Base Sepolia.

## Notes

- AgentKit 0.10.x sends anonymous analytics. If that post fails, it leaves an unhandled rejection, so `examples/paid-call.ts` ignores only that specific error.
- Market data and analysis only, not investment advice. Blockchain IQ's terms: https://www.blockchainiq.co/terms

## License

MIT
