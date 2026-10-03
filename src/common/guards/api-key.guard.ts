import { ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SCOPES_KEY } from '../decorators/scopes.decorator';
import { matchScope } from '../guards/scopes.guard';
import { ErrorCode } from '../constants/error-codes';
import { UnauthorizedException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Guard enforcing API Key authentication ('api-key' passport strategy)
 * and validating that the key holder possesses the required permission scopes.
 * Bypassed when route or controller is marked `@Public()`.
 *
 * Requests lacking required scopes receive 403 Forbidden.
 */
@Injectable()
export class ApiKeyGuard extends AuthGuard('api-key') {
  private _requiredScopes: string[] | undefined;

  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    this._requiredScopes = this.reflector.getAllAndOverride<string[] | undefined>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new UnauthorizedException('Invalid or missing API key', ErrorCode.UNAUTHORIZED);
    }

    if (!this._requiredScopes || this._requiredScopes.length === 0) {
      return user;
    }

    const principal = user as unknown as AuthenticatedUser;
    const grantedScopes = [
      ...(principal.scopes ?? []),
      ...(principal.permissions ?? []),
    ];

    const missingScopes = this._requiredScopes.filter(
      (required) => !grantedScopes.some((granted) => matchScope(granted, required)),
    );

    if (missingScopes.length > 0) {
      throw new ForbiddenException(
        `Insufficient API key permissions. Missing required scope(s): ${missingScopes.join(', ')}`,
      );
    }

    return user;
  }
}