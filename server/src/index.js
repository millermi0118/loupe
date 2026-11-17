// Entry point: load config, build the Anthropic client from server-side env, start listening.
import Anthropic from '@anthropic-ai/sdk';
import { loadDotEnv, loadConfig } from './config.js';
import { createSelector } from './judge.js';
import { dailyBudget } from './pricing.js';
import { createServer, consoleLogger } from './server.js';

loadDotEnv();
const config = loadConfig();

if (!config.hasApiKey) {
  console.error('ANTHROPIC_API_KEY is not set. Copy server/.env.example to server/.env and add your key (see server/README.md).');
  process.exit(1);
}

// Reads ANTHROPIC_API_KEY from the environment. One retry on 429/5xx/connection errors keeps
// the worst-case wait (and spend) bounded.
const client = new Anthropic({ maxRetries: 1, timeout: config.requestTimeoutMs });
const budget = dailyBudget(config.dailyBudgetUsd);
const select = createSelector({ client, model: config.model, effort: config.effort, fallbacks: config.fallbacks, logger: consoleLogger, budget });
const server = createServer({ config, select, budget, logger: consoleLogger });

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`Loupe server on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}  (model ${config.model}, effort ${config.effort}, daily budget ${config.dailyBudgetUsd ? '$' + config.dailyBudgetUsd : 'none'})`);
  console.log(`Allowed browser origins: ${[...config.allowedOrigins].join(', ')}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn(`Listening on ${config.host}. This prototype has no user authentication; anyone who can reach this port can use the Anthropic key. Set HOST=127.0.0.1 for local-only use.`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
