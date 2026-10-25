import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, http, type Chain } from "viem";
import { base, baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { blockchainIQActionProvider, eventRiskUrl, briefUrl, BASE_USDC } from "../src/index.js";
import { mockBlockchainIQ, decodePayment, FAKE_TX } from "./mock.js";

// AgentKit itself posts anonymous analytics with the global fetch; keep tests fully offline.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.includes("coinbase.com")) return new Response(null, { status: 204 });
  throw new Error(`unexpected network call in tests: ${u}`);
}) as typeof fetch;
void realFetch;

const PAY_TO = "0x617dA9383fbA67e86137BC4924b8b7E400fB7C9e";

function wallet(chain: Chain = base) {
  const account = privateKeyToAccount(generatePrivateKey()); // throwaway, unfunded
  return { account, provider: new ViemWalletProvider(createWalletClient({ account, chain, transport: http("http://127.0.0.1:9") })) };
}

async function actions(fetchImpl: typeof fetch, maxUsdPerCall?: number) {
  const { account, provider } = wallet();
  const kit = await AgentKit.from({ walletProvider: provider, actionProviders: [blockchainIQActionProvider({ fetchImpl, maxUsdPerCall })] });
  const list = kit.getActions();
  const get = (suffix: string) => list.find((a) => a.name.endsWith(suffix))!;
  return { account, list, brief: get("get_market_brief"), eventRisk: get("get_event_risk") };
}

test("registers two actions with AgentKit", async () => {
  const { list } = await actions(mockBlockchainIQ().impl);
  const names = list.map((a) => a.name).filter((n) => n.includes("blockchainiq") || n.includes("BlockchainIQ"));
  assert.equal(names.length, 2, JSON.stringify(list.map((a) => a.name)));
});

test("brief: 402 -> signs exact USDC payment of 10000 (0.01) to Blockchain IQ on Base -> returns data + tx hash", async () => {
  const m = mockBlockchainIQ();
  const { brief, account } = await actions(m.impl);
  const out = JSON.parse(await brief.invoke({}));
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.settlement.transaction, FAKE_TX);
  assert.equal(out.explorer, `https://basescan.org/tx/${FAKE_TX}`);
  assert.equal(out.data.coins[0].symbol, "btc");
  assert.equal(m.seen.length, 2);
  assert.equal(m.seen[0].paymentSignature, undefined);
  const p = decodePayment(m.seen[1].paymentSignature!);
  assert.equal(p.x402Version, 2);
  assert.equal(p.accepted.amount, "10000");
  assert.equal(p.accepted.network, "eip155:8453");
  assert.equal(p.accepted.asset, BASE_USDC);
  assert.equal(p.accepted.payTo, PAY_TO);
  assert.equal(p.payload.authorization.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(p.payload.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(p.payload.authorization.value, "10000");
  assert.match(p.payload.signature, /^0x[0-9a-f]{130}$/i);
});

test("event-risk: passes days/minImportance and pays 50000 (0.05)", async () => {
  const m = mockBlockchainIQ();
  const { eventRisk } = await actions(m.impl);
  const out = JSON.parse(await eventRisk.invoke({ days: 14, minImportance: 3 }));
  assert.equal(out.ok, true);
  assert.equal(new URL(m.seen[1].url).search, "?days=14&minImportance=3");
  assert.equal(decodePayment(m.seen[1].paymentSignature!).accepted.amount, "50000");
  assert.equal(out.data[0].title, "FOMC decision");
});

test("spend cap: refuses to pay event-risk ($0.05) when capped at $0.02, no paid retry sent", async () => {
  const m = mockBlockchainIQ();
  const { eventRisk } = await actions(m.impl, 0.02);
  const out = JSON.parse(await eventRisk.invoke({}));
  assert.equal(out.ok, false);
  assert.match(out.error, /maxAmountPerPayment|spend/i);
  assert.equal(m.seen.filter((s) => s.paymentSignature).length, 0);
});

test("payment rejected by server -> ok:false with reason, no data", async () => {
  const m = mockBlockchainIQ({ failSettle: true });
  const { brief } = await actions(m.impl);
  const out = JSON.parse(await brief.invoke({}));
  assert.equal(out.ok, false);
  assert.equal(out.status, 402);
  assert.match(out.error, /payment not accepted/);
  assert.equal(out.data, undefined);
});

test("server error is surfaced, never charged", async () => {
  const m = mockBlockchainIQ({ status: 500 });
  const { brief } = await actions(m.impl);
  const out = JSON.parse(await brief.invoke({}));
  assert.equal(out.ok, false);
  assert.equal(out.status, 500);
  assert.equal(m.seen.filter((s) => s.paymentSignature).length, 0);
});

test("schema validation: days out of range is rejected before any request", async () => {
  const m = mockBlockchainIQ();
  const { eventRisk } = await actions(m.impl);
  const out = JSON.parse(await eventRisk.invoke({ days: 365 }));
  assert.equal(out.ok, false);
  assert.match(out.error, /invalid input: days/);
  assert.equal(m.seen.length, 0);
  assert.throws(() => eventRiskUrl({ days: 0 }));
  assert.equal(briefUrl(), "https://www.blockchainiq.co/api/x402/v1/brief");
});

test("supportsNetwork: Base mainnet only", () => {
  const p = blockchainIQActionProvider();
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" }), true);
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", networkId: "base-sepolia", chainId: "84532" }), false);
  assert.equal(p.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" }), false);
});

test("provider is not offered on a Base Sepolia wallet", async () => {
  const { provider } = wallet(baseSepolia);
  const kit = await AgentKit.from({ walletProvider: provider, actionProviders: [blockchainIQActionProvider()] });
  assert.equal(kit.getActions().filter((a) => /blockchainiq/i.test(a.name)).length, 0);
});
