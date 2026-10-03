import { describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

const ALL_ROLES = Object.values(UserRole);

/** Controller fixtures carrying real `@Roles` metadata at class and handler level. */
@Roles(UserRole.ADMIN, UserRole.FINANCE)
class FinanceController {
  inheritsClassRoles() {}

  @Roles(UserRole.AUDITOR)
  handlerOverridesClass() {}

  @Roles()
  emptyHandlerRoles() {}
}

class OpenController {
  unrestricted() {}

  @Roles(UserRole.VIEWER)
  viewerOnly() {}

  @Roles(UserRole.OWNER)
  ownerOnly() {}
}

function user(role: UserRole | string, overrides: Partial<AuthenticatedUser> = {}) {
  return { id: 'u-1', organizationId: 'org-1', role, ...overrides } as AuthenticatedUser;
}

function context(
  cls: new () => object,
  handler: string,
  principal?: AuthenticatedUser,
): ExecutionContext {
  const target = cls.prototype as Record<string, () => void>;
  return {
    getHandler: () => target[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: principal }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  describe('routes without role metadata', () => {
    it('allows guests because authentication is enforced by the JWT guard, not here', () => {
      expect(guard.canActivate(context(OpenController, 'unrestricted'))).toBe(true);
    });

    it.each(ALL_ROLES)('allows %s', (role) => {
      expect(guard.canActivate(context(OpenController, 'unrestricted', user(role)))).toBe(true);
    });

    it('treats an empty @Roles() on the handler as no restriction, even under a restricted class', () => {
      expect(
        guard.canActivate(context(FinanceController, 'emptyHandlerRoles', user(UserRole.VIEWER))),
      ).toBe(true);
    });
  });

  describe('guest access', () => {
    it.each([
      [OpenController, 'viewerOnly'],
      [OpenController, 'ownerOnly'],
      [FinanceController, 'inheritsClassRoles'],
    ] as const)('rejects an unauthenticated request to %s.%s with 401', (cls, handler) => {
      expect(() => guard.canActivate(context(cls, handler))).toThrow(UnauthorizedException);
    });

    it('rejects a principal whose session expired (strategy attached no user) with 401', () => {
      expect(() => guard.canActivate(context(OpenController, 'ownerOnly', undefined))).toThrow(
        'Authentication required for this resource',
      );
    });
  });

  describe('administrative override', () => {
    it.each([
      [FinanceController, 'inheritsClassRoles'],
      [FinanceController, 'handlerOverridesClass'],
      [OpenController, 'viewerOnly'],
    ] as const)('OWNER satisfies %s.%s without being listed', (cls, handler) => {
      expect(guard.canActivate(context(cls, handler, user(UserRole.OWNER)))).toBe(true);
    });

    it('ADMIN receives no implicit override', () => {
      expect(() =>
        guard.canActivate(context(OpenController, 'ownerOnly', user(UserRole.ADMIN))),
      ).toThrow(ForbiddenException);
    });

    it('applies the OWNER override to API-key principals too', () => {
      expect(
        guard.canActivate(
          context(OpenController, 'viewerOnly', user(UserRole.OWNER, { isApiKey: true })),
        ),
      ).toBe(true);
    });
  });

  describe('class and handler inheritance', () => {
    /**
     * Assertion matrix: for every role, the expected outcome of each route.
     * Handler metadata replaces (does not merge with) class metadata.
     */
    const matrix: Array<[UserRole, { inherits: boolean; override: boolean; owner: boolean }]> = [
      [UserRole.OWNER, { inherits: true, override: true, owner: true }],
      [UserRole.ADMIN, { inherits: true, override: false, owner: false }],
      [UserRole.FINANCE, { inherits: true, override: false, owner: false }],
      [UserRole.DEVELOPER, { inherits: false, override: false, owner: false }],
      [UserRole.AUDITOR, { inherits: false, override: true, owner: false }],
      [UserRole.VIEWER, { inherits: false, override: false, owner: false }],
    ];

    it('covers every role in the enum', () => {
      expect(matrix.map(([role]) => role).sort()).toEqual([...ALL_ROLES].sort());
    });

    it.each(matrix)('%s -> %j', (role, expected) => {
      const outcome = (cls: new () => object, handler: string) => {
        try {
          return guard.canActivate(context(cls, handler, user(role)));
        } catch (error) {
          expect(error).toBeInstanceOf(ForbiddenException);
          return false;
        }
      };

      expect({
        inherits: outcome(FinanceController, 'inheritsClassRoles'),
        override: outcome(FinanceController, 'handlerOverridesClass'),
        owner: outcome(OpenController, 'ownerOnly'),
      }).toEqual(expected);
    });
  });

  describe('standard user restrictions', () => {
    it('names the actual role and the accepted roles in the 403 message', () => {
      expect(() =>
        guard.canActivate(context(FinanceController, 'inheritsClassRoles', user(UserRole.VIEWER))),
      ).toThrow("Role 'VIEWER' is not permitted. Requires one of: ADMIN, FINANCE");
    });

    it('rejects a stale role that is no longer part of the enum', () => {
      expect(() =>
        guard.canActivate(context(OpenController, 'viewerOnly', user('SUPERUSER'))),
      ).toThrow(ForbiddenException);
    });

    it('does not match roles case-insensitively', () => {
      expect(() => guard.canActivate(context(OpenController, 'ownerOnly', user('owner')))).toThrow(
        ForbiddenException,
      );
    });
  });
});
