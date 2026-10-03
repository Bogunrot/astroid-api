import { describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { matchScope, ScopesGuard } from './scopes.guard';
import { RequireScopes, RequiredScopes, Scopes } from '../decorators/scopes.decorator';
import { Public } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ErrorCode } from '../constants/error-codes';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

describe('matchScope', () => {
  /** [granted, required, expected] */
  const matrix: Array<[string, string, boolean]> = [
    // Global wildcards
    ['*', 'transactions:write', true],
    ['admin', 'wallets:read', true],
    ['*', 'anything', true],
    // Exact
    ['transactions:write', 'transactions:write', true],
    ['transactions:read', 'transactions:write', false],
    ['wallets:read', 'transactions:read', false],
    // Resource wildcard
    ['transactions:*', 'transactions:write', true],
    ['transactions:*', 'transactions:read', true],
    ['transactions:*', 'wallets:read', false],
    ['transactions:*', 'transactions', true],
    // Nested permissions inherit from a resource wildcard...
    ['transactions:*', 'transactions:write:bulk', true],
    // ...but a wildcard is only honoured at the action position
    ['transactions:write:*', 'transactions:write:bulk', false],
    ['transactions:write', 'transactions:write:bulk', false],
    ['*:write', 'transactions:write', false],
    // A bare resource grants nothing
    ['transactions', 'transactions:read', false],
    // Case-sensitive, and no prefix collisions
    ['Transactions:*', 'transactions:read', false],
    ['ADMIN', 'wallets:read', false],
    ['trans:*', 'transactions:read', false],
    ['', 'transactions:read', false],
  ];

  it.each(matrix)('granted %j, required %j -> %s', (granted, required, expected) => {
    expect(matchScope(granted, required)).toBe(expected);
  });
});

@RequireScopes('transactions:read')
class TransactionsController {
  inheritsClass() {}

  @Scopes('transactions:write', 'wallets:read')
  requiresTwo() {}

  @RequiredScopes()
  emptyHandler() {}

  @Public()
  publicHandler() {}
}

@Public()
class PublicController {
  @RequireScopes('transactions:write')
  scopedButPublic() {}
}

class OpenController {
  unrestricted() {}
}

interface Principal {
  role?: UserRole;
  isApiKey?: boolean;
  scopes?: string[];
  permissions?: string[];
}

function user({ role = UserRole.VIEWER, ...rest }: Principal = {}): AuthenticatedUser {
  return { id: 'u-1', organizationId: 'org-1', role, ...rest };
}

function context(
  cls: new () => object,
  handler: string,
  principal?: AuthenticatedUser,
  apiKey?: { permissions?: string[] },
): ExecutionContext {
  const target = cls.prototype as Record<string, () => void>;
  return {
    getHandler: () => target[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: principal, apiKey }) }),
  } as unknown as ExecutionContext;
}

describe('ScopesGuard', () => {
  const guard = new ScopesGuard(new Reflector());

  describe('public and unrestricted routes', () => {
    it.each([
      [TransactionsController, 'publicHandler'],
      [PublicController, 'scopedButPublic'],
    ] as const)('lets a guest through @Public() on %s.%s', (cls, handler) => {
      expect(guard.canActivate(context(cls, handler))).toBe(true);
    });

    it('lets a guest through a route without scope metadata', () => {
      expect(guard.canActivate(context(OpenController, 'unrestricted'))).toBe(true);
    });

    it('treats an empty handler requirement as no restriction, overriding the class', () => {
      expect(guard.canActivate(context(TransactionsController, 'emptyHandler', user()))).toBe(true);
    });
  });

  describe('guest access', () => {
    it('rejects an unauthenticated request with 401 and the UNAUTHORIZED code', () => {
      let caught: unknown;
      try {
        guard.canActivate(context(TransactionsController, 'inheritsClass'));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnauthorizedException);
      expect((caught as UnauthorizedException).code).toBe(ErrorCode.UNAUTHORIZED);
      expect((caught as UnauthorizedException).getStatus()).toBe(401);
    });

    it('rejects an expired API key (auth layer attached no principal) even if its scopes arrive', () => {
      expect(() =>
        guard.canActivate(
          context(TransactionsController, 'inheritsClass', undefined, { permissions: ['*'] }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('administrative override', () => {
    it.each([UserRole.OWNER, UserRole.ADMIN])(
      'a JWT-authenticated %s satisfies every scope without holding any',
      (role) => {
        expect(
          guard.canActivate(context(TransactionsController, 'requiresTwo', user({ role }))),
        ).toBe(true);
      },
    );

    it.each([UserRole.OWNER, UserRole.ADMIN])(
      'an API key carrying the %s role gets no bypass and must hold the scopes',
      (role) => {
        expect(() =>
          guard.canActivate(
            context(TransactionsController, 'requiresTwo', user({ role, isApiKey: true })),
          ),
        ).toThrow(ForbiddenException);
      },
    );

    it.each([UserRole.FINANCE, UserRole.DEVELOPER, UserRole.AUDITOR, UserRole.VIEWER])(
      'a JWT-authenticated %s gets no bypass',
      (role) => {
        expect(() =>
          guard.canActivate(context(TransactionsController, 'inheritsClass', user({ role }))),
        ).toThrow(ForbiddenException);
      },
    );
  });

  describe('scope sources', () => {
    it.each<[string, AuthenticatedUser, { permissions?: string[] } | undefined]>([
      ['user.scopes', user({ scopes: ['transactions:read'] }), undefined],
      ['user.permissions', user({ permissions: ['transactions:read'] }), undefined],
      ['request.apiKey.permissions', user(), { permissions: ['transactions:read'] }],
    ])('accepts a scope granted via %s', (_source, principal, apiKey) => {
      expect(
        guard.canActivate(context(TransactionsController, 'inheritsClass', principal, apiKey)),
      ).toBe(true);
    });

    it('combines scopes from every source to satisfy a multi-scope route', () => {
      expect(
        guard.canActivate(
          context(TransactionsController, 'requiresTwo', user({ scopes: ['transactions:write'] }), {
            permissions: ['wallets:read'],
          }),
        ),
      ).toBe(true);
    });

    it('tolerates an API-key request object without a permissions list', () => {
      expect(() =>
        guard.canActivate(context(TransactionsController, 'inheritsClass', user(), {})),
      ).toThrow(ForbiddenException);
    });
  });

  describe('standard user restrictions', () => {
    it('lists only the missing scopes in the 403 message', () => {
      expect(() =>
        guard.canActivate(
          context(TransactionsController, 'requiresTwo', user({ scopes: ['wallets:read'] })),
        ),
      ).toThrow('Missing required scope(s): transactions:write');
    });

    it('lists every missing scope when none are held', () => {
      expect(() =>
        guard.canActivate(context(TransactionsController, 'requiresTwo', user({ isApiKey: true }))),
      ).toThrow('Missing required scope(s): transactions:write, wallets:read');
    });

    it('honours wildcard grants on a multi-scope route', () => {
      expect(
        guard.canActivate(
          context(
            TransactionsController,
            'requiresTwo',
            user({ isApiKey: true, scopes: ['transactions:*', 'wallets:*'] }),
          ),
        ),
      ).toBe(true);
    });

    it('does not let a resource wildcard leak into another resource', () => {
      expect(() =>
        guard.canActivate(
          context(TransactionsController, 'requiresTwo', user({ scopes: ['transactions:*'] })),
        ),
      ).toThrow('Missing required scope(s): wallets:read');
    });
  });
});
