import { z } from "zod";

export const GetMarketBriefSchema = z
  .object({})
  .strip()
  .describe("No input. Returns the Blockchain IQ market brief ($0.01 USDC on Base).");

export const GetEventRiskSchema = z
  .object({
    days: z.number().int().min(1).max(90).optional().describe("How many days ahead to look, 1-90 (default 7)"),
    minImportance: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional()
      .describe("Only events at or above this importance: 1 = everything, 3 = only market-moving"),
  })
  .strip()
  .describe("Scheduled market-moving events from Blockchain IQ ($0.05 USDC on Base).");
