import "reflect-metadata";
import { z } from "zod";
import { ActionProvider, CreateAction, EvmWalletProvider, type Network } from "@coinbase/agentkit";
import { GetEventRiskSchema, GetMarketBriefSchema } from "./schemas.js";
import { BLOCKCHAINIQ_API, DEFAULT_MAX_USD_PER_CALL, briefUrl, createPaidFetch, eventRiskUrl, paidGet } from "./x402.js";

export interface BlockchainIQActionProviderConfig {
  /** Refuse any single payment above this many US dollars. Default 0.06 (event-risk is $0.05). */
  maxUsdPerCall?: number;
  /** Override the API base URL (tests). */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Blockchain IQ action provider: crypto market data bought per call over x402 v2,
 * paid in USDC on Base from the AgentKit EVM wallet. No API key, no account.
 */
export class BlockchainIQActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly cfg: Required<Omit<BlockchainIQActionProviderConfig, "fetchImpl">> & { fetchImpl?: typeof fetch };

  constructor(config: BlockchainIQActionProviderConfig = {}) {
    super("blockchainiq", []);
    this.cfg = {
      maxUsdPerCall: config.maxUsdPerCall ?? DEFAULT_MAX_USD_PER_CALL,
      baseUrl: config.baseUrl ?? BLOCKCHAINIQ_API,
      fetchImpl: config.fetchImpl,
    };
  }

  private payFetch(wallet: EvmWalletProvider) {
    return createPaidFetch({ signer: wallet.toSigner() as any, maxUsdPerCall: this.cfg.maxUsdPerCall, fetchImpl: this.cfg.fetchImpl });
  }

  @CreateAction({
    name: "get_market_brief",
    description: `Buys the Blockchain IQ crypto market brief for $0.01 USDC on Base (x402, paid from this wallet).
Returns BTC, ETH, SOL and XRP prices with 24h/7d/30d moves and rank, scheduled macro and crypto events in the next 48 hours, and short risk flags.
Use it as the opening call of a trading, portfolio or research loop. Market data only, not investment advice.
The result includes the settlement transaction hash of the payment.`,
    schema: GetMarketBriefSchema,
  })
  async getMarketBrief(wallet: EvmWalletProvider, _args: z.infer<typeof GetMarketBriefSchema>): Promise<string> {
    return JSON.stringify(await paidGet(this.payFetch(wallet), "brief", briefUrl(this.cfg.baseUrl)));
  }

  @CreateAction({
    name: "get_event_risk",
    description: `Buys Blockchain IQ's event-risk calendar for $0.05 USDC on Base (x402, paid from this wallet).
Returns scheduled market-moving events (US data releases, FOMC/ECB/BoJ decisions, Treasury auctions, crypto and regulatory milestones) for the next 7 days by default (days 1-90), each with importance 1-3 and its official source.
Use it before any trade or scheduled action. The result includes the settlement transaction hash.`,
    schema: GetEventRiskSchema,
  })
  async getEventRisk(wallet: EvmWalletProvider, args: z.infer<typeof GetEventRiskSchema>): Promise<string> {
    const parsed = GetEventRiskSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return JSON.stringify({ ok: false, status: 0, resource: "event-risk", error: `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
    }
    let url: string;
    try {
      url = eventRiskUrl(parsed.data, this.cfg.baseUrl);
    } catch (e) {
      return JSON.stringify({ ok: false, status: 0, resource: "event-risk", error: (e as Error).message });
    }
    return JSON.stringify(await paidGet(this.payFetch(wallet), "event-risk", url));
  }

  /** Blockchain IQ is paid in USDC on Base mainnet only. */
  supportsNetwork = (network: Network) => network.protocolFamily === "evm" && (network.networkId === "base-mainnet" || network.chainId === "8453");
}

export const blockchainIQActionProvider = (config?: BlockchainIQActionProviderConfig) => new BlockchainIQActionProvider(config);
