import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { LoginDto } from '../src/auth.dto';

describe('LoginDto', () => {
  it('accepts a bounded username and password', async () => {
    const errors = await validate(plainToInstance(LoginDto, { username: 'admin', password: 'secret' }));
    expect(errors).toHaveLength(0);
  });

  it('rejects missing or oversized credentials before hashing', async () => {
    const missing = await validate(plainToInstance(LoginDto, {}));
    const oversized = await validate(plainToInstance(LoginDto, { username: 'u'.repeat(101), password: 'p'.repeat(257) }));
    expect(missing).toHaveLength(2);
    expect(oversized).toHaveLength(2);
  });
});
