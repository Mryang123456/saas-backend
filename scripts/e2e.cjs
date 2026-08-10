require('dotenv').config();
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../dist/main.js');

const tenant = 'acme';
const base = `/api/v1/tenants/${tenant}`;

async function main() {
  assert(process.env.SEED_PASSWORD, 'SEED_PASSWORD is required for the E2E gate');
  const app = await createApp();
  const tokens = {};

  async function request(method, url, { token, payload, headers = {}, expected = 200 } = {}) {
    const response = await app.inject({
      method,
      url,
      payload,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
    let body;
    if (response.body) body = response.json();
    assert.equal(
      response.statusCode,
      expected,
      `${method} ${url}: expected ${expected}, received ${response.statusCode}: ${response.body}`,
    );
    return body;
  }

  async function login(username) {
    const body = await request('POST', `${base}/auth/login`, {
      payload: { username, password: process.env.SEED_PASSWORD },
      expected: 201,
    });
    tokens[username] = body.data.token;
    return body.data;
  }

  async function createAndSubmit(label) {
    const createKey = `e2e-create-${randomUUID()}`;
    const payload = {
      title: `E2E ${label} ${new Date().toISOString()}`,
      reason: 'Automated real-database acceptance verification',
      costCenter: 'E2E-QA',
      items: [{ name: 'Verification item', quantity: '2.5000', unitPriceCents: 12345 }],
    };
    const created = await request('POST', `${base}/applications`, {
      token: tokens.alice,
      payload,
      headers: { 'idempotency-key': createKey },
      expected: 201,
    });
    const replay = await request('POST', `${base}/applications`, {
      token: tokens.alice,
      payload,
      headers: { 'idempotency-key': createKey },
      expected: 201,
    });
    assert.equal(replay.data.id, created.data.id, 'create idempotency replay must return the same application');
    assert.equal(created.data.totalAmountCents, 30863, 'line amount must use half-up rounding');

    await request('GET', `/api/v1/tenants/not-acme/applications/${created.data.id}`, {
      token: tokens.alice,
      expected: 403,
    });

    const submitKey = `e2e-submit-${randomUUID()}`;
    const submitted = await request('POST', `${base}/applications/${created.data.id}/submit`, {
      token: tokens.alice,
      payload: { version: created.data.version },
      headers: { 'idempotency-key': submitKey },
    });
    const submitReplay = await request('POST', `${base}/applications/${created.data.id}/submit`, {
      token: tokens.alice,
      payload: { version: created.data.version },
      headers: { 'idempotency-key': submitKey },
    });
    assert.equal(submitReplay.data.applicationNo, submitted.data.applicationNo, 'submit replay must preserve the application number');
    assert.equal(submitted.data.status, 'PENDING_DEPT_MANAGER');
    return submitted.data;
  }

  try {
    for (const username of ['alice', 'manager', 'finance1', 'owner', 'admin', 'auditor']) await login(username);

    await request('GET', `${base}/audit-logs`, { token: tokens.alice, expected: 403 });

    let approved = await createAndSubmit('approval');
    await request('POST', `${base}/applications/${approved.id}/approval-actions`, {
      token: tokens.finance1,
      payload: { action: 'APPROVE', version: approved.version },
      expected: 403,
    });
    approved = (await request('POST', `${base}/applications/${approved.id}/approval-actions`, {
      token: tokens.manager,
      payload: { action: 'APPROVE', version: approved.version },
      expected: 201,
    })).data;
    assert.equal(approved.status, 'PENDING_FINANCE');
    approved = (await request('POST', `${base}/applications/${approved.id}/approval-actions`, {
      token: tokens.finance1,
      payload: { action: 'APPROVE', version: approved.version },
      expected: 201,
    })).data;
    assert.equal(approved.status, 'PENDING_TENANT_OWNER');
    approved = (await request('POST', `${base}/applications/${approved.id}/approval-actions`, {
      token: tokens.owner,
      payload: { action: 'APPROVE', version: approved.version },
      expected: 201,
    })).data;
    assert.equal(approved.status, 'APPROVED');

    const history = await request('GET', `${base}/applications/${approved.id}/approval-history`, { token: tokens.auditor });
    assert.equal(history.data.items.length, 4, 'approved flow must contain one submission and three approvals');

    let rejected = await createAndSubmit('rejection');
    rejected = (await request('POST', `${base}/applications/${rejected.id}/approval-actions`, {
      token: tokens.manager,
      payload: { action: 'REJECT', comment: 'E2E rejection path', version: rejected.version },
      expected: 201,
    })).data;
    assert.equal(rejected.status, 'REJECTED');

    const audit = await request('GET', `${base}/audit-logs?pageSize=100`, { token: tokens.admin });
    const targetEvents = audit.data.items.filter((item) => item.targetId === approved.id || item.targetId === rejected.id);
    assert(targetEvents.some((item) => item.eventType === 'APPLICATION_CREATED'));
    assert(targetEvents.some((item) => item.eventType === 'APPLICATION_SUBMITTED'));
    assert(targetEvents.some((item) => item.eventType === 'APPROVAL_APPROVED'));
    assert(targetEvents.some((item) => item.eventType === 'APPROVAL_REJECTED'));

    console.log('PASS seeded role logins');
    console.log('PASS create and submit idempotency');
    console.log('PASS tenant and role isolation');
    console.log('PASS three-level approval flow');
    console.log('PASS rejection flow');
    console.log('PASS approval history and audit trace');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
