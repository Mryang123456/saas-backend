import { describe,expect,it } from 'vitest';
import Decimal from 'decimal.js';
describe('amount calculation',()=>{it('uses decimal half-up rather than binary float',()=>expect(new Decimal('2.5000').mul(101).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber()).toBe(253));});
