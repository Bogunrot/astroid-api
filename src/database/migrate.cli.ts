import { spawn } from 'child_process';
import { PrismaInvocation, runMigrationCli } from './migration-guard';

/**
 * Migration CLI entry point: `npm run db:migrate -- <command> [migration] [--force]`.
 *
 * All argument parsing and the production rollback guard live in
 * `migration-guard.ts`; this file only wires them to the real process.
 */
function runPrisma({ args, stdin }: PrismaInvocation): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['prisma', ...args], {
      stdio: [stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    child.on('error', (error) => {
      process.stderr.write(`Failed to start prisma: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

if (require.main === module) {
  runMigrationCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    runPrisma,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
