import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateApplicationDto, UpdateApplicationDto } from '../src/modules/applications/applications.dto';

const draft = {
  title: '研发设备采购',
  reason: '扩充研发团队设备',
  costCenter: 'R&D-2026',
  items: [{ name: '笔记本电脑', quantity: '2.0000', unitPriceCents: 899900, note: null }],
};

describe('application draft DTOs', () => {
  it('accepts a complete draft in the create request', async () => {
    expect(await validate(plainToInstance(CreateApplicationDto, draft))).toHaveLength(0);
  });

  it('requires items on create and a version on edit', async () => {
    const createErrors = await validate(plainToInstance(CreateApplicationDto, { title: '不完整草稿' }));
    const updateErrors = await validate(plainToInstance(UpdateApplicationDto, draft));
    expect(createErrors.some(error => error.property === 'items')).toBe(true);
    expect(updateErrors.some(error => error.property === 'version')).toBe(true);
  });

  it('rejects empty item arrays and whitespace-only names', async () => {
    const emptyItems = await validate(plainToInstance(CreateApplicationDto, { ...draft, items: [] }));
    const blankNames = await validate(plainToInstance(CreateApplicationDto, { ...draft, title: '   ', items: [{ ...draft.items[0], name: '   ' }] }));
    expect(emptyItems.some(error => error.property === 'items')).toBe(true);
    expect(blankNames.some(error => error.property === 'title')).toBe(true);
    expect(blankNames.find(error => error.property === 'items')?.children?.[0]?.children?.some(error => error.property === 'name')).toBe(true);
  });
});
