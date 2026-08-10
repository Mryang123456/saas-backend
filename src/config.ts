import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().regex(/^mysql:\/\//, 'DATABASE_URL must use the mysql:// scheme'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28800),
  SESSION_TOKEN_PEPPER: z.string().min(32),
  PASSWORD_PEPPER: z.string().default(''),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.enum(['true','false']).default('false'),
  LOG_LEVEL: z.string().default('info'),
});
export type AppConfig = z.infer<typeof schema>;
export const MINIMUM_MYSQL_VERSION = '8.0.16';

export function assertSupportedMySqlVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || /mariadb/i.test(version)) throw new Error(`Unsupported database server ${version}; MySQL ${MINIMUM_MYSQL_VERSION}+ is required`);
  const current = match.slice(1).map(Number);
  const minimum = MINIMUM_MYSQL_VERSION.split('.').map(Number);
  const supported = current.some((part, index) => part > minimum[index] && current.slice(0, index).every((value, prior) => value === minimum[prior])) || current.every((part, index) => part === minimum[index]);
  if (!supported) throw new Error(`Unsupported MySQL ${version}; MySQL ${MINIMUM_MYSQL_VERSION}+ is required`);
}

export function validateConfig(input: Record<string, unknown>): AppConfig {
  const value = schema.parse(input);
  const origins = value.CORS_ALLOWED_ORIGINS.split(',').map((x) => x.trim());
  if (origins.includes('*')) throw new Error('CORS wildcard is forbidden');
  if (value.NODE_ENV === 'production' && origins.some((x) => !x.startsWith('https://') || x.includes('localhost'))) throw new Error('Production CORS origins must be exact HTTPS origins');
  return value;
}
