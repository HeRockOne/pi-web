import type { AgentMessage, AgentUsage } from "./types";

/**
 * What one turn consumed, flattened so a totals row needs no nested cost object.
 * Every response inside the turn is included, because every response re-sends the
 * conversation: a round costs the sum over its requests, not what its last answer
 * happened to report.
 */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

/** A message's usage in totals form (cost lives under `cost.total` on the wire). */
export function usageTotals(usage: AgentUsage): TurnUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    costTotal: usage.cost?.total ?? 0,
  };
}

/** Prompt tokens of a totals row, cached and uncached alike. */
export function promptTokens(usage: TurnUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Every token a totals row accounts for. */
export function totalTokens(usage: TurnUsage): number {
  return promptTokens(usage) + usage.output;
}

/**
 * A finished turn's usage: every response in `messages[anchorIdx + 1, endIdx)`
 * summed, the same range the turn's clock is read from (lib/turn-duration.ts).
 * Undefined when no response in the turn reported usage.
 */
export function getTurnUsage(messages: AgentMessage[], anchorIdx: number, endIdx: number): TurnUsage | undefined {
  let totals: TurnUsage | undefined;
  for (let idx = anchorIdx + 1; idx < endIdx; idx++) {
    const message = messages[idx];
    if (message.role !== "assistant" || !message.usage) continue;
    const row = usageTotals(message.usage);
    totals = totals
      ? {
          input: totals.input + row.input,
          output: totals.output + row.output,
          cacheRead: totals.cacheRead + row.cacheRead,
          cacheWrite: totals.cacheWrite + row.cacheWrite,
          costTotal: totals.costTotal + row.costTotal,
        }
      : row;
  }
  if (!totals) return undefined;
  return totalTokens(totals) > 0 || totals.costTotal > 0 ? totals : undefined;
}
