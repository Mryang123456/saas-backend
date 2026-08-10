require('dotenv').config();
const { createApp } = require('../dist/main.js');

async function main() {
  const app = await createApp();
  const probes = [
    { name: 'liveness', url: '/health/live', expected: 200 },
    { name: 'database readiness', url: '/health/ready', expected: 200 },
    { name: 'OpenAPI contract', url: '/api/docs-json', expected: 200 },
  ];

  if (process.env.NODE_ENV !== 'production' && process.env.SEED_PASSWORD) {
    probes.push({
      name: 'seeded SaaS login',
      method: 'POST',
      url: '/api/v1/tenants/acme/auth/login',
      payload: { username: 'admin', password: process.env.SEED_PASSWORD },
      expected: 201,
    });
  }

  try {
    for (const probe of probes) {
      const response = await app.inject({ method: probe.method || 'GET', url: probe.url, payload: probe.payload });
      if (response.statusCode !== probe.expected) {
        throw new Error(`${probe.name} failed: expected ${probe.expected}, received ${response.statusCode}`);
      }
      console.log(`PASS ${probe.name} (${response.statusCode})`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
