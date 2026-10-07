import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-strategy';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { extractApiKeyFromRequest } from '../../common/helpers/extract-api-key';
import { ErrorCode } from '../../common/constants/error-codes';
import { UnauthorizedException } from '../../common/exceptions/domain.exception';
import { AuthenticatedApiKey } from '../../common/interfaces/authenticated-user.interface';
import { ApiKeyService } from '../developer/api-key.service';

/**
 * Low-level Passport strategy extracting the API key from request headers.
 */
export class HeaderApiKeyPassportStrategy extends Strategy {
  readonly name = 'api-key';

  authenticate(req: Request, _options?: unknown): void {
    const apiKey = extractApiKeyFromRequest(req);

    if (!apiKey) {
      return this.fail(
        new UnauthorizedException('Missing API key header', ErrorCode.UNAUTHORIZED) as never,
        401,
      );
    }

    // Invoke NestJS PassportStrategy's validate method
    (this as unknown as { validate: (key: string, request: Request) => Promise<AuthenticatedApiKey> })
      .validate(apiKey, req)
      .then((principal) => {
        if (!principal) {
          this.fail(
            new UnauthorizedException(
              'Invalid or expired API key',
              ErrorCode.UNAUTHORIZED,
            ) as never,
            401,
          );
        } else {
          this.success(principal);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedException) {
          this.fail(err as never, 401);
        } else {
          this.error(err as Error);
        }
      });
  }
}

/**
 * Passport strategy validating programmatic SHA-256 hashed API keys.
 * Attaches the authenticated API key principal and its permission scopes to `req.user`.
 */
@Injectable()
export class ApiKeyStrategy extends PassportStrategy(HeaderApiKeyPassportStrategy, 'api-key') {
  constructor(private readonly apiKeyService: ApiKeyService) {
    super();
  }

  async validate(rawKey: string, req?: Request): Promise<AuthenticatedApiKey> {
    const apiKey = await this.apiKeyService.verify(rawKey);
    if (!apiKey) {
      throw new UnauthorizedException('Invalid or expired API key', ErrorCode.UNAUTHORIZED);
    }

    const principal: AuthenticatedApiKey = {
      id: apiKey.id,
      keyId: apiKey.id,
      apiKeyId: apiKey.id,
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

    if (req) {
      (req as unknown as Record<string, unknown>).apiKey = apiKey;
    }

    return principal;
  }
}
