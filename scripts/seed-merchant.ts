/**
 * CLI wrapper around createMerchant. Usage:
 *   bun run seed:merchant -- --merchant-id=m_smoke --name="Smoke Kirana" \
 *     --csv=fixtures/merchant-a.csv --policy=fixtures/merchant-a.policy.json \
 *     [--agent-label="default agent"]
 *
 * Prints the raw agent token to stdout exactly once. Nothing else in this
 * codebase is allowed to print a raw token.
 */
import { readFileSync } from 'node:fs';
import { closePool } from '../src/db/pool';
import { createMerchant } from '../src/onboard/create-merchant';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return args;
}

function requireArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required --${name} argument`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const merchantId = requireArg(args, 'merchant-id');
  const name = requireArg(args, 'name');
  const csvPath = requireArg(args, 'csv');
  const policyPath = requireArg(args, 'policy');
  const agentLabel = args['agent-label'] ?? 'default-agent';

  const csv = readFileSync(csvPath, 'utf8');
  const policyJson: unknown = JSON.parse(readFileSync(policyPath, 'utf8'));

  const result = await createMerchant({ merchantId, name, csv, policyJson, agentLabel });

  console.log(`merchant created: ${result.merchant.id} (${result.merchant.name})`);
  console.log(`products loaded: ${result.productCount}`);
  console.log(`agent created: ${result.agent.id} (${result.agent.label})`);
  console.log('agent token (shown once — save it now):');
  console.log(result.token);
}

try {
  await main();
} finally {
  await closePool();
}
