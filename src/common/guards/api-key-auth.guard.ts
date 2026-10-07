import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ApiKey, UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ErrorCode } from '../constants/error-codes';
import { UnauthorizedException } from '../exceptions/domain.exception';
import { AuthenticatedApiKey } from '../interfaces/authenticated-user.interface';
import { extractApiKeyFromRequest } from '../helpers/extract-api-key';
import { ApiKeyService } from '../../modules/developer/api-key.service';

type ApiKeyAuthenticatedRequest = Request & {
  user?: AuthenticatedApiKey;
  apiKey?: ApiKey;
};

/**
 * Guard enforcing cryptographic API key authentication on protected routes.
 * Extracts the key from `x-api-key`, verifies the Argon2id hash against PostgreSQL
 * (with SHA-256 fallback for legacy keys), rejects revoked or expired keys, and
 * attaches scoped permissions to the request.
 * 
 * Uses constant-time comparison via Argon2 verification to prevent timing attacks.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<ApiKeyAuthenticatedRequest>();
    const rawKey = extractApiKeyFromRequest(request);
    if (!rawKey) {
      throw new UnauthorizedException('Missing API key header', ErrorCode.UNAUTHORIZED);
    }

    const apiKey = await this.apiKeyService.verify(rawKey);
    if (!apiKey) {
      throw new UnauthorizedException('Invalid or expired API key', ErrorCode.UNAUTHORIZED);
    }

    const principal: AuthenticatedApiKey = {
      id: apiKey.id,
      keyId: apiKey.id,
      organizationId: apiKey.organizationId,
      createdById: apiKey.createdById,
      name: apiKey.name,
      prefix: apiKey.prefix,
      permissions: apiKey.permissions ?? [],
      scopes: apiKey.permissions ?? [],
      allowedIps: apiKey.allowedIps ?? [],
      isApiKey: true,
      role: UserRole.DEVELOPER,
    };

    request.user = principal;
    request.apiKey = apiKey;
    return true;
  }
}
