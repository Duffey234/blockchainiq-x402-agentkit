// One real paid call through the AgentKit action provider. Spends real USDC on Base.
//   AGENT_PRIVATE_KEY=0x... npm run paid-call                 -> brief, $0.01
//   AGENT_PRIVATE_KEY=0x... npm run paid-call -- event-risk   -> event-risk, $0.05
// Use a dedicated wallet holding a few cents of USDC on Base; it needs no ETH (settlement is gasless).
import "reflect-metadata";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { blockchainIQActionProvider } from "../src/index.js";

// AgentKit 0.10.x posts anonymous analytics and leaves a failed post as an unhandled rejection,
// which would kill this script before the paid call finishes. Ignore only that one error.
process.on("unhandledRejection", (e: any) => {
  if (String(e?.stack ?? e).includes("sendAnalyticsEvent")) return;
  console.error(e);
  process.exit(1);
});

const key = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Set AGENT_PRIVATE_KEY to a 0x-prefixed private key of a wallet holding USDC on Base.");
  process.exit(2);
}
const which = (process.argv[2] ?? "brief").toLowerCase();
if (!["brief", "event-risk"].includes(which)) {
  console.error("Usage: npm run paid-call -- [brief|event-risk]");
  process.exit(2);
}

const account = privateKeyToAccount(key);
const walletProvider = new ViemWalletProvider(createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC_URL) }));
const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [blockchainIQActionProvider({ maxUsdPerCall: Number(process.env.MAX_USD_PER_CALL ?? 0.06) })],
});
const action = agentkit.getActions().find((a) => a.name.endsWith(which === "brief" ? "get_market_brief" : "get_event_risk"));
if (!action) throw new Error("Blockchain IQ actions not registered (wallet must be on Base mainnet)");

console.log(`payer ${account.address} -> ${action.name}`);
const out = JSON.parse(await action.invoke({}));
if (out.data !== undefined) console.log(JSON.stringify(out.data, null, 2).slice(0, 2000));
console.log("\nproof of settlement:", JSON.stringify(out.settlement ?? null));
if (out.explorer) console.log("transaction:", out.explorer);
if (!out.ok) {
  console.error("call failed:", out.error);
  process.exit(1);
}
