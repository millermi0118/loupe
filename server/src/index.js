// Entry point: load config, build the Anthropic client from server-side env, start listening.
import Anthropic from '@anthropic-ai/sdk';
import { loadDotEnv, loadConfig } from './config.js';
import { createJudge } from './judge.js';
import { createServer, consoleLogger } from './server.js';

loadDotEnv();
const config = loadConfig();

if (!config.hasApiKey) {
  console.error('ANTHROPIC_API_KEY is not set. Copy server/.env.example to server/.env and add your key (see server/README.md).');
  process.exit(1);
}

// Reads ANTHROPIC_API_KEY from the environment. Retries 429/5xx/connection errors twice.
const client = new Anthropic({ maxRetries: 2, timeout: config.requestTimeoutMs });
const judge = createJudge({ client, model: config.model, effort: config.effort, fallbacks: config.fallbacks });
const server = createServer({ config, judge, logger: consoleLogger });

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log(`Loupe server on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}  (model ${config.model}, effort ${config.effort})`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('Warning: listening beyond this machine. This prototype has no user authentication; do not expose it publicly.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
