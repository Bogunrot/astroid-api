import { UserRole } from '@prisma/client';

/** The authenticated principal attached to each request by JWT or API key strategies. */
export interface AuthenticatedUser {
  id: string;
  sub?: string;
  organizationId: string;
  email?: string;
  role: UserRole;
  tier?: string;
  sessionId?: string;
  apiKeyId?: string;
  createdById?: string | null;
  scopes?: string[];
  permissions?: string[];
  isApiKey?: boolean;
}

/** The authenticated principal attached to each request when authenticated with an API key. */
export interface AuthenticatedApiKey {
  id: string;
  keyId: string;
  apiKeyId?: string;
  organizationId: string;
  createdById?: string | null;
  name: string;
  prefix: string;
  permissions: string[];
  scopes: string[];
  allowedIps: string[];
  isApiKey: true;
  role: UserRole;
  email?: string;
}

/** Shape of the JWT access-token payload. */
export interface JwtAccessPayload {
  sub: string;
  organizationId: string;
  email: string;
  role: UserRole;
  sessionId?: string;
}

/** Shape of the JWT refresh-token payload. */
export interface JwtRefreshPayload {
  sub: string;
  sessionId: string;
}

