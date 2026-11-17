// Estimated cost of one Messages API call, in US dollars, from the usage the API returns.
// Prices are per million tokens (Anthropic first-party list prices). Estimates only: the
// Anthropic Console is the source of truth for billing.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function estimateCostUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const cost = ((usage.input_tokens || 0) * p.input
    + (usage.output_tokens || 0) * p.output
    + (usage.cache_read_input_tokens || 0) * p.cacheRead
    + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

// In-memory daily spend guard (UTC day, this process only). Stops a public endpoint from
// running up an unbounded bill; not a substitute for per-user quotas.
export function dailyBudget(limitUsd, now = () => Date.now()) {
  let day = '', spent = 0;
  const roll = () => { const d = new Date(now()).toISOString().slice(0, 10); if (d !== day) { day = d; spent = 0; } };
  return {
    exhausted: () => { roll(); return limitUsd > 0 && spent >= limitUsd; },
    add: (usd) => { roll(); spent += usd || 0; },
    spent: () => { roll(); return spent; },
  };
}
