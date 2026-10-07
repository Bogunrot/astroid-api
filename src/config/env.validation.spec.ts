import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  assertValidEnvironment,
  environmentSchema,
  EnvironmentValidationError,
  INSECURE_DEFAULT_ENCRYPTION_KEY,
} from './env.validation';

/** The smallest environment that satisfies every required key. */
const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://astroid:astroid@localhost:5432/astroid',
  JWT_ACCESS_SECRET: 'access-secret-at-least-16-chars',
  JWT_REFRESH_SECRET: 'refresh-secret-at-least-16-chars',
  AI_PROVIDER_KEY: 'nvapi-test-key',
} as const;

/** Parses a dotenv file into key/value pairs (comments and blanks skipped). */
function parseDotenv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) {
      env[match[1]] = match[2];
    }
  }
  return env;
}

/** Runs the validator and returns the thrown error, failing if none is thrown. */
function validationError(env: NodeJS.ProcessEnv): EnvironmentValidationError {
  try {
    assertValidEnvironment(env);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentValidationError);
    return error as EnvironmentValidationError;
  }
  throw new Error('Expected environment validation to fail');
}

const ROOT = resolve(__dirname, '..', '..');

describe('assertValidEnvironment', () => {
  it('accepts a configuration containing only the required keys and applies defaults', () => {
    const env = assertValidEnvironment({ ...REQUIRED_ENV });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.REDIS_HOST).toBe('localhost');
    expect(env.STELLAR_USE_MOCK).toBe(true);
    expect(env.DATABASE_URL).toBe(REQUIRED_ENV.DATABASE_URL);
  });

  it('accepts the documented .env.example as-is', () => {
    expect(() => assertValidEnvironment(parseDotenv(resolve(ROOT, '.env.example')))).not.toThrow();
  });

  it('reports every missing required variable together, not just the first', () => {
    const error = validationError({});

    expect(error.issues.map((issue) => issue.key).sort()).toEqual([
      'AI_PROVIDER_KEY',
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ]);
    for (const issue of error.issues) {
      expect(issue.message).toBe('is required but was not set');
    }
    expect(error.message).toContain('Invalid environment configuration (4 problems):');
    expect(error.message).toContain('  - DATABASE_URL: is required but was not set');
    expect(error.message).toContain('.env.example');
  });

  it('treats an empty required value as missing', () => {
    const error = validationError({ ...REQUIRED_ENV, DATABASE_URL: '' });

    expect(error.issues).toEqual([{ key: 'DATABASE_URL', message: 'DATABASE_URL is required' }]);
  });

  it('rejects malformed values with a descriptive message per key', () => {
    const error = validationError({
      ...REQUIRED_ENV,
      NODE_ENV: 'staging',
      PORT: 'not-a-port',
      REDIS_PORT: '-1',
      STELLAR_USE_MOCK: 'yes',
      JWT_ACCESS_SECRET: 'short',
      ENCRYPTION_KEY: 'too-short',
    });

    const byKey = Object.fromEntries(error.issues.map((issue) => [issue.key, issue.message]));
    expect(byKey).toEqual({
      NODE_ENV: 'must be one of: development, test, production',
      PORT: 'must be a valid number',
      REDIS_PORT: expect.stringContaining('greater than 0'),
      STELLAR_USE_MOCK: 'must be one of: true, false',
      JWT_ACCESS_SECRET: 'JWT_ACCESS_SECRET must be >= 16 chars',
      ENCRYPTION_KEY: expect.stringContaining('32-byte'),
    });
  });

  it('never echoes the offending values, which may be secrets', () => {
    const secret = 'hunter2-not-an-enum-value';
    const error = validationError({
      ...REQUIRED_ENV,
      NODE_ENV: secret,
      STELLAR_NETWORK: secret,
      JWT_REFRESH_SECRET: 'tiny-secret',
    });

    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('tiny-secret');
  });

  describe('in production', () => {
    const PRODUCTION_ENV = {
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      ENCRYPTION_KEY: 'a'.repeat(64),
    } as const;

    it('accepts a securely configured environment', () => {
      expect(() => assertValidEnvironment({ ...PRODUCTION_ENV })).not.toThrow();
    });

    it('rejects the publicly known default encryption key, explicit or implied', () => {
      for (const env of [
        { ...PRODUCTION_ENV, ENCRYPTION_KEY: INSECURE_DEFAULT_ENCRYPTION_KEY },
        { ...PRODUCTION_ENV, ENCRYPTION_KEY: undefined },
      ]) {
        const error = validationError(env);
        expect(error.issues).toEqual([
          {
            key: 'ENCRYPTION_KEY',
            message: expect.stringContaining('unique secret in production'),
          },
        ]);
      }
    });

    it('rejects reusing the access-token secret for refresh tokens', () => {
      const error = validationError({
        ...PRODUCTION_ENV,
        JWT_REFRESH_SECRET: PRODUCTION_ENV.JWT_ACCESS_SECRET,
      });

      expect(error.issues).toEqual([
        { key: 'JWT_REFRESH_SECRET', message: 'must differ from JWT_ACCESS_SECRET in production' },
      ]);
    });

    it('does not apply the production rules in development', () => {
      expect(() =>
        assertValidEnvironment({
          ...REQUIRED_ENV,
          JWT_REFRESH_SECRET: REQUIRED_ENV.JWT_ACCESS_SECRET,
        }),
      ).not.toThrow();
    });
  });
});

describe('configuration documentation', () => {
  const schemaKeys = Object.keys(environmentSchema.innerType().shape);

  it('documents every validated variable in docs/configuration.md', () => {
    const doc = readFileSync(resolve(ROOT, 'docs', 'configuration.md'), 'utf8');
    const undocumented = schemaKeys.filter((key) => !doc.includes(`\`${key}\``));

    expect(undocumented).toEqual([]);
  });

  it('lists every required variable in .env.example', () => {
    const example = parseDotenv(resolve(ROOT, '.env.example'));

    for (const key of Object.keys(REQUIRED_ENV)) {
      expect(example).toHaveProperty(key);
    }
  });
});
