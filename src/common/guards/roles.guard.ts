import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

/**
 * Authorises a request by RBAC role. OWNER implicitly satisfies every
 * requirement. Routes without `@Roles(...)` metadata are allowed for any
 * authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('Authentication required for this resource');
    }

    if (user.role === UserRole.OWNER || required.includes(user.role)) {
      return true;
    }

    throw new ForbiddenException(
      `Role '${user.role}' is not permitted. Requires one of: ${required.join(', ')}`,
    );
  }
}
