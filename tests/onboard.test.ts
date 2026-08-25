import { afterAll, describe, expect, test } from 'bun:test';
import { hashToken } from '../src/auth/token';
import { pool, query, queryOne } from '../src/db/pool';
import { createMerchant } from '../src/onboard/create-merchant';

const FIXTURE_CSV = await Bun.file(`${import.meta.dir}/../fixtures/merchant-a.csv`).text();
const FIXTURE_POLICY: unknown = await Bun.file(
  `${import.meta.dir}/../fixtures/merchant-a.policy.json`,
).json();

async function cleanupMerchant(merchantId: string): Promise<void> {
  await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
}

describe('createMerchant', () => {
  test('onboards a merchant, its policy, catalog, and first agent in one call', async () => {
    const merchantId = 'm_onboard_smoke';
    await cleanupMerchant(merchantId);

    const result = await createMerchant({
      merchantId,
      name: 'Onboard Smoke Kirana',
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: 'smoke-agent',
    });

    expect(result.merchant.id).toBe(merchantId);
    expect(result.productCount).toBe(5);
    expect(result.policy.merchant_id).toBe(merchantId);
    expect(result.agent.merchant_id).toBe(merchantId);
    expect(result.token).toMatch(/^dk_/);

    const productCount = await queryOne<{ count: string }>(
      'SELECT count(*)::text AS count FROM products WHERE merchant_id = $1',
      [merchantId],
    );
    const policyCount = await queryOne<{ count: string }>(
      'SELECT count(*)::text AS count FROM policies WHERE merchant_id = $1',
      [merchantId],
    );
    const agentRows = await query<{ id: string; token_hash: string }>(
      'SELECT id, token_hash FROM agents WHERE merchant_id = $1',
      [merchantId],
    );

    expect(productCount?.count).toBe('5');
    expect(policyCount?.count).toBe('1');
    expect(agentRows).toHaveLength(1);

    // The stored hash matches hashToken(rawToken), and the raw token itself
    // never appears in the row — only its digest does.
    const agentRow = agentRows[0];
    expect(agentRow?.token_hash).toBe(hashToken(result.token));
    expect(agentRow?.token_hash).not.toBe(result.token);

    await cleanupMerchant(merchantId);
  });

  test('a policy with an unreachable escalate branch is rejected before any row is written', async () => {
    const merchantId = 'm_onboard_bad_policy';
    await cleanupMerchant(merchantId);

    const badPolicy = {
      spend_cap_rupees: '500.00',
      approval_threshold_rupees: '1000.00',
      category_allowlist: ['groceries'],
      window: '24h',
    };

    await expect(
      createMerchant({
        merchantId,
        name: 'Bad Policy Kirana',
        csv: FIXTURE_CSV,
        policyJson: badPolicy,
        agentLabel: 'smoke-agent',
      }),
    ).rejects.toThrow(/unreachable/);

    const merchantRow = await queryOne('SELECT id FROM merchants WHERE id = $1', [merchantId]);
    expect(merchantRow).toBeNull();
  });

  test('a duplicate merchant id rolls back the whole transaction', async () => {
    const merchantId = 'm_onboard_dupe';
    await cleanupMerchant(merchantId);

    await createMerchant({
      merchantId,
      name: 'Original Kirana',
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: 'agent-one',
    });

    await expect(
      createMerchant({
        merchantId,
        name: 'Duplicate Kirana',
        csv: FIXTURE_CSV,
        policyJson: FIXTURE_POLICY,
        agentLabel: 'agent-two',
      }),
    ).rejects.toThrow();

    // Only the first agent exists — the second call's inserts never committed.
    const agentRows = await query('SELECT id FROM agents WHERE merchant_id = $1', [merchantId]);
    expect(agentRows).toHaveLength(1);

    await cleanupMerchant(merchantId);
  });
});

afterAll(async () => {
  // src/db/pool.ts exports ONE process-wide Pool singleton shared by every
  // test file in the same `bun test` process. Closing it here would break
  // whichever file runs next, so it is deliberately left open; bun exits
  // regardless.
});
