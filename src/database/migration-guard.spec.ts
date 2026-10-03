import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPrismaInvocations,
  checkMigrationSafety,
  isProductionEnv,
  MigrationCliError,
  parseMigrationArgs,
  PrismaInvocation,
  runMigrationCli,
} from './migration-guard';

const MIGRATIONS_DIR = path.join('prisma', 'migrations');
const MIGRATION = '20260901080000_add_cleanup_job_logs';
const DOWN_SQL = 'DROP TABLE "cleanup_job_logs";\n';

function migrationFile(name: string) {
  return path.join(MIGRATIONS_DIR, MIGRATION, name);
}

describe('isProductionEnv', () => {
  it.each([
    ['production', true],
    ['PRODUCTION', true],
    ['  production ', true],
    ['development', false],
    ['test', false],
    ['prod', false],
    ['', false],
    [undefined, false],
  ])('NODE_ENV=%j -> %s', (value, expected) => {
    expect(isProductionEnv(value)).toBe(expected);
  });
});

describe('parseMigrationArgs', () => {
  it('parses a down command with its target and --force in any position', () => {
    expect(parseMigrationArgs(['--force', 'down', MIGRATION])).toEqual({
      command: 'down',
      migration: MIGRATION,
      force: true,
    });
  });

  it('parses non-destructive commands without force', () => {
    expect(parseMigrationArgs(['deploy'])).toEqual({
      command: 'deploy',
      migration: undefined,
      force: false,
    });
  });

  it.each([
    [[], /missing command/],
    [['drop'], /Unknown or missing command 'drop'/],
    [['down'], /requires a migration name/],
    [['deploy', 'extra'], /Unexpected argument/],
    [['down', MIGRATION, 'extra'], /Unexpected argument/],
    [['down', MIGRATION, '--yes'], /Unknown option\(s\): --yes/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseMigrationArgs(argv)).toThrow(MigrationCliError);
    expect(() => parseMigrationArgs(argv)).toThrow(message);
  });
});

describe('checkMigrationSafety', () => {
  const prod = { NODE_ENV: 'production' };

  it.each(['down', 'reset'] as const)('blocks %s in production without --force', (command) => {
    const decision = checkMigrationSafety({ command, force: false }, prod);
    expect(decision.allowed).toBe(false);
    expect(decision.warning).toContain(`'${command}'`);
    expect(decision.warning).toContain('NODE_ENV=production');
    expect(decision.warning).toContain('--force');
  });

  it.each(['down', 'reset'] as const)(
    'allows %s in production with --force and warns',
    (command) => {
      const decision = checkMigrationSafety({ command, force: true }, prod);
      expect(decision.allowed).toBe(true);
      expect(decision.warning).toMatch(/^WARNING: --force supplied/);
    },
  );

  it.each(['deploy', 'status'] as const)('never blocks non-destructive %s', (command) => {
    expect(checkMigrationSafety({ command, force: false }, prod)).toEqual({ allowed: true });
  });

  it.each([{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }, {}])(
    'allows destructive commands outside production (%j)',
    (env) => {
      expect(checkMigrationSafety({ command: 'down', force: false }, env)).toEqual({
        allowed: true,
      });
    },
  );
});

describe('buildPrismaInvocations', () => {
  const options = (files: string[] = []) => ({
    migrationsDir: MIGRATIONS_DIR,
    schemaPath: 'schema.prisma',
    exists: (file: string) => files.includes(file),
    readFile: () => DOWN_SQL,
  });

  it.each([
    ['deploy', ['migrate', 'deploy', '--schema', 'schema.prisma']],
    ['status', ['migrate', 'status', '--schema', 'schema.prisma']],
    ['reset', ['migrate', 'reset', '--schema', 'schema.prisma']],
  ] as const)('maps %s to prisma %j', (command, args) => {
    expect(buildPrismaInvocations({ command, force: false }, options())).toEqual([{ args }]);
  });

  it('runs down.sql and the history delete as a single script', () => {
    const [invocation, ...rest] = buildPrismaInvocations(
      { command: 'down', migration: MIGRATION, force: false },
      options([migrationFile('migration.sql'), migrationFile('down.sql')]),
    );

    expect(rest).toHaveLength(0);
    expect(invocation.args).toEqual(['db', 'execute', '--stdin', '--schema', 'schema.prisma']);
    expect(invocation.stdin).toBe(
      `DROP TABLE "cleanup_job_logs";\n\n` +
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}';\n`,
    );
  });

  it('rejects a migration name that could escape the SQL literal or folder', () => {
    for (const name of ["x'; DROP TABLE users; --", '../0_init', '']) {
      expect(() =>
        buildPrismaInvocations({ command: 'down', migration: name, force: false }, options()),
      ).toThrow(/Invalid migration name/);
    }
  });

  it('rejects an unknown migration', () => {
    expect(() =>
      buildPrismaInvocations({ command: 'down', migration: MIGRATION, force: false }, options()),
    ).toThrow(/not found/);
  });

  it('rejects a migration without a down.sql', () => {
    expect(() =>
      buildPrismaInvocations(
        { command: 'down', migration: MIGRATION, force: false },
        options([migrationFile('migration.sql')]),
      ),
    ).toThrow(/has no down\.sql/);
  });
});

describe('runMigrationCli', () => {
  let stdout: ReturnType<typeof vi.fn>;
  let stderr: ReturnType<typeof vi.fn>;
  let runPrisma: ReturnType<typeof vi.fn<(invocation: PrismaInvocation) => Promise<number>>>;

  const deps = (env: Record<string, string | undefined>) => ({
    env,
    stdout,
    stderr,
    runPrisma,
    migrationsDir: MIGRATIONS_DIR,
    exists: (file: string) =>
      file === migrationFile('migration.sql') || file === migrationFile('down.sql'),
    readFile: () => DOWN_SQL,
  });

  beforeEach(() => {
    stdout = vi.fn();
    stderr = vi.fn();
    runPrisma = vi.fn<(invocation: PrismaInvocation) => Promise<number>>().mockResolvedValue(0);
  });

  it('rejects a production rollback without --force, warns on stderr and never calls prisma', async () => {
    const code = await runMigrationCli(['down', MIGRATION], deps({ NODE_ENV: 'production' }));

    expect(code).toBe(1);
    expect(runPrisma).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Refusing to run'));
  });

  it('rejects a production reset without --force', async () => {
    expect(await runMigrationCli(['reset'], deps({ NODE_ENV: 'production' }))).toBe(1);
    expect(runPrisma).not.toHaveBeenCalled();
  });

  it('runs a production rollback when --force is supplied', async () => {
    const code = await runMigrationCli(
      ['down', MIGRATION, '--force'],
      deps({ NODE_ENV: 'production' }),
    );

    expect(code).toBe(0);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^WARNING: --force supplied/));
    expect(runPrisma).toHaveBeenCalledTimes(1);
    expect(runPrisma.mock.calls[0][0].stdin).toContain('DELETE FROM "_prisma_migrations"');
    expect(stdout).toHaveBeenCalledWith(`Rolled back migration '${MIGRATION}'.`);
  });

  it('runs a rollback in development without --force or warnings', async () => {
    expect(await runMigrationCli(['down', MIGRATION], deps({ NODE_ENV: 'development' }))).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(runPrisma).toHaveBeenCalledTimes(1);
  });

  it('runs deploy in production without --force', async () => {
    expect(await runMigrationCli(['deploy'], deps({ NODE_ENV: 'production' }))).toBe(0);
    expect(runPrisma).toHaveBeenCalledWith({
      args: ['migrate', 'deploy', '--schema', path.join('prisma', 'schema.prisma')],
    });
  });

  it('propagates a prisma failure as the exit code', async () => {
    runPrisma.mockResolvedValue(3);

    expect(await runMigrationCli(['down', MIGRATION], deps({}))).toBe(3);
    expect(stderr).toHaveBeenCalledWith('prisma db execute exited with code 3');
    expect(stdout).not.toHaveBeenCalled();
  });

  it('reports usage errors with exit code 2', async () => {
    expect(await runMigrationCli(['rollback'], deps({}))).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^Usage: db:migrate/));
    expect(runPrisma).not.toHaveBeenCalled();
  });

  it('checks the production guard before validating the migration on disk', async () => {
    const code = await runMigrationCli(
      ['down', 'missing_migration'],
      deps({ NODE_ENV: 'production' }),
    );

    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Refusing to run'));
  });
});
