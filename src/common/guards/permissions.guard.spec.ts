import { describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { PermissionsGuard } from './permissions.guard';
import { Permissions, RequirePermissions } from '../decorators/permissions.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

@RequirePermissions('reports:read')
class ReportsController {
  inheritsClass() {}

  @RequirePermissions('reports:write', 'reports:publish')
  requiresBoth() {}

  @Permissions('reports:export')
  viaAlias() {}

  @RequirePermissions()
  emptyHandler() {}
}

class OpenController {
  unrestricted() {}
}

function user(permissions?: string[], role: UserRole = UserRole.VIEWER): AuthenticatedUser {
  return { id: 'u-1', organizationId: 'org-1', role, permissions };
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

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector());

  describe('routes without permission metadata', () => {
    it('allows a guest', () => {
      expect(guard.canActivate(context(OpenController, 'unrestricted'))).toBe(true);
    });

    it('treats an empty handler requirement as no restriction, overriding the class', () => {
      expect(guard.canActivate(context(ReportsController, 'emptyHandler', user([])))).toBe(true);
    });
  });

  describe('guest access', () => {
    it('rejects an unauthenticated request with 401', () => {
      expect(() => guard.canActivate(context(ReportsController, 'inheritsClass'))).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('permission matrix', () => {
    /** [granted permissions, route, expected to pass] */
    const matrix: Array<[string[] | undefined, string, boolean]> = [
      [['reports:read'], 'inheritsClass', true],
      [['reports:read', 'extra'], 'inheritsClass', true],
      [['reports:write'], 'inheritsClass', false],
      [['reports:write', 'reports:publish'], 'requiresBoth', true],
      [['reports:publish', 'reports:write', 'reports:read'], 'requiresBoth', true],
      [['reports:write'], 'requiresBoth', false],
      [['reports:read'], 'requiresBoth', false],
      [['reports:export'], 'viaAlias', true],
      [['reports:read'], 'viaAlias', false],
      [[], 'inheritsClass', false],
      [undefined, 'inheritsClass', false],
    ];

    it.each(matrix)('granted %j on %s -> %s', (granted, handler, allowed) => {
      const run = () => guard.canActivate(context(ReportsController, handler, user(granted)));
      if (allowed) {
        expect(run()).toBe(true);
      } else {
        expect(run).toThrow(ForbiddenException);
      }
    });
  });

  describe('standard user restrictions', () => {
    it('requires every listed permission and names them all in the 403 message', () => {
      expect(() =>
        guard.canActivate(context(ReportsController, 'requiresBoth', user(['reports:write']))),
      ).toThrow('Missing required permissions. Requires: reports:write, reports:publish');
    });

    it('does not expand wildcards; that is ScopesGuard behaviour', () => {
      expect(() =>
        guard.canActivate(context(ReportsController, 'inheritsClass', user(['reports:*', '*']))),
      ).toThrow(ForbiddenException);
    });

    it('matches permissions case-sensitively', () => {
      expect(() =>
        guard.canActivate(context(ReportsController, 'inheritsClass', user(['REPORTS:READ']))),
      ).toThrow(ForbiddenException);
    });
  });

  describe('administrative override', () => {
    it.each([UserRole.OWNER, UserRole.ADMIN])(
      'grants %s no implicit bypass: explicit permissions are still required',
      (role) => {
        expect(() =>
          guard.canActivate(context(ReportsController, 'inheritsClass', user([], role))),
        ).toThrow(ForbiddenException);
        expect(
          guard.canActivate(
            context(ReportsController, 'inheritsClass', user(['reports:read'], role)),
          ),
        ).toBe(true);
      },
    );
  });
});
