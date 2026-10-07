import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

/**
 * Authorises a request by required fine-grained permissions.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
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

    const userPermissions = user.permissions || [];
    const hasAll = required.every((perm) => userPermissions.includes(perm));

    if (hasAll) {
      return true;
    }

    throw new ForbiddenException(
      `Missing required permissions. Requires: ${required.join(', ')}`,
    );
  }
}
