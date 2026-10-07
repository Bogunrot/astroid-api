import { describe, expect, it } from 'vitest';
import {
  inviteMemberSchema,
  updateMemberSchema,
  updateOrganizationSchema,
} from './organization.dto';
import { OrganizationPlan, UserRole, UserStatus } from '@prisma/client';

describe('updateOrganizationSchema', () => {
  it('accepts a valid partial update', () => {
    const result = updateOrganizationSchema.parse({ name: 'Acme Corp', plan: OrganizationPlan.FREE });
    expect(result.name).toBe('Acme Corp');
    expect(result.plan).toBe(OrganizationPlan.FREE);
  });

  it('sanitizes whitespace from name and description', () => {
    const result = updateOrganizationSchema.parse({
      name: '  Acme  Corp  ',
      description: 'A  company\n  that builds things',
    });
    expect(result.name).toBe('Acme Corp');
    expect(result.description).toBe('A company that builds things');
  });

  it('rejects a name that is too short', () => {
    expect(() => updateOrganizationSchema.parse({ name: 'A' })).toThrow();
  });

  it('rejects an invalid logo URL', () => {
    expect(() => updateOrganizationSchema.parse({ logo: 'not-a-url' })).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() => updateOrganizationSchema.parse({ name: 'Acme Corp', unknownField: 'x' })).toThrow();
  });
});

describe('inviteMemberSchema', () => {
  it('accepts a valid invitation', () => {
    const result = inviteMemberSchema.parse({
      name: 'Alice',
      email: 'alice@example.com',
      role: UserRole.DEVELOPER,
    });
    expect(result.name).toBe('Alice');
    expect(result.email).toBe('alice@example.com');
    expect(result.role).toBe(UserRole.DEVELOPER);
  });

  it('sanitizes whitespace from name', () => {
    const result = inviteMemberSchema.parse({
      name: '  Alice  Smith  ',
      email: 'alice@example.com',
      role: UserRole.DEVELOPER,
    });
    expect(result.name).toBe('Alice Smith');
  });

  it('rejects an invalid email', () => {
    expect(() =>
      inviteMemberSchema.parse({ name: 'Alice', email: 'not-email', role: UserRole.DEVELOPER }),
    ).toThrow();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      inviteMemberSchema.parse({
        name: 'Alice',
        email: 'alice@example.com',
        role: UserRole.DEVELOPER,
        extra: 'x',
      }),
    ).toThrow();
  });
});

describe('updateMemberSchema', () => {
  it('accepts a valid role change', () => {
    expect(updateMemberSchema.parse({ role: UserRole.ADMIN }).role).toBe(UserRole.ADMIN);
  });

  it('accepts a valid status change', () => {
    expect(updateMemberSchema.parse({ status: UserStatus.ACTIVE }).status).toBe(UserStatus.ACTIVE);
  });

  it('accepts an empty update', () => {
    expect(updateMemberSchema.parse({})).toEqual({});
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() => updateMemberSchema.parse({ role: UserRole.ADMIN, extra: 'x' })).toThrow();
  });
});
