import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());

vi.mock('@nestjs/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nestjs/core')>()),
  NestFactory: { create },
}));

/**
 * Exercises the real `main.ts` entrypoint to prove configuration is validated
 * before Nest builds a single module. `NestFactory.create` is mocked so a
 * passing validation stops at the factory instead of opening connections.
 */
describe('bootstrap environment validation', () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let sandbox: string;
  let exit: MockInstance<typeof process.exit>;
  let consoleError: MockInstance<typeof console.error>;

  const REQUIRED_ENV = {
    DATABASE_URL: 'postgresql://astroid:astroid@localhost:5432/astroid',
    JWT_ACCESS_SECRET: 'access-secret-at-least-16-chars',
    JWT_REFRESH_SECRET: 'refresh-secret-at-least-16-chars',
    AI_PROVIDER_KEY: 'nvapi-test-key',
  };

  /** Imports a fresh copy of `main.ts` and waits for bootstrap to settle. */
  async function runMain(): Promise<void> {
    vi.resetModules();
    await import('./main');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 10_000 });
  }

  beforeEach(() => {
    // Run from an empty directory so a developer's local `.env` cannot leak
    // into the environment under test via ConfigModule's env-file loading.
    sandbox = mkdtempSync(join(tmpdir(), 'astroid-env-'));
    process.chdir(sandbox);

    const env = { ...originalEnv };
    for (const key of Object.keys(REQUIRED_ENV)) {
      delete env[key];
    }
    process.env = env;

    create.mockReset().mockRejectedValue(new Error('stop after validation'));
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(sandbox, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('halts with exit code 1 and a descriptive message when required variables are missing', async () => {
    await runMain();

    expect(create).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);

    const output = consoleError.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Invalid environment configuration');
    for (const key of Object.keys(REQUIRED_ENV)) {
      expect(output).toContain(`${key}: is required but was not set`);
    }
    // The dedicated message is printed on its own, without a stack trace.
    expect(output).not.toContain('Failed to bootstrap');
  }, 30_000);

  it('halts before building the application when a value is malformed', async () => {
    process.env = { ...process.env, ...REQUIRED_ENV, PORT: 'eighty' };

    await runMain();

    expect(create).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('PORT: must be a valid number'),
    );
  }, 30_000);

  it('proceeds to create the application when the configuration is valid', async () => {
    process.env = { ...process.env, ...REQUIRED_ENV };

    await runMain();

    expect(create).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Invalid environment configuration'),
    );
  }, 30_000);
});
