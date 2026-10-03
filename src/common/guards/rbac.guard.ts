import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { PermissionsGuard } from './permissions.guard';

/**
 * Combined RBAC guard checking both roles (@Roles) and fine-grained permissions (@RequirePermissions).
 */
@Injectable()
export class RbacGuard implements CanActivate {
  private readonly rolesGuard: RolesGuard;
  private readonly permissionsGuard: PermissionsGuard;

  constructor(reflector: Reflector) {
    this.rolesGuard = new RolesGuard(reflector);
    this.permissionsGuard = new PermissionsGuard(reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rolesAllowed = this.rolesGuard.canActivate(context);
    if (!rolesAllowed) {
      return false;
    }
    return this.permissionsGuard.canActivate(context);
  }
}
