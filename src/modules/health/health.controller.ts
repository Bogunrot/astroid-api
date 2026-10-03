import { Controller, Get, HttpException, HttpStatus, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { HealthIndicatorResult } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../../common/decorators/skip-audit.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { SkipPublicRateLimit } from '../../common/decorators/skip-public-rate-limit.decorator';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { BullMQHealthIndicator, QueuesHealthReport } from './indicators/bullmq.health';

/** Per-dependency report shape returned under `services` in the readiness body. */
interface ReadinessServiceReport {
  status: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Health and probe endpoints. Public (orchestrators and load balancers carry no
 * credentials), excluded from rate limiting so frequent probes can never be
 * answered with a 429, and excluded from the audit trail so probes do not write
 * a row per request — or attempt to while the database is down.
 *
 * `GET /health/live` and `GET /health/ready` are the orchestrator probes and are
 * served outside the global API prefix (see `main.ts`); the remaining routes are
 * richer diagnostics served under it.
 */
@ApiTags('Health')
@Controller('health')
@Public()
@SkipAudit()
@SkipThrottle({ api: true, auth: true })
export class HealthController {
  constructor(
    private readonly dbIndicator: PrismaHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly stellarIndicator: StellarHealthIndicator,
    private readonly migrationIndicator: DatabaseMigrationHealthIndicator,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 whenever the process is running and able to serve HTTP. Performs no ' +
      'dependency checks, so a downstream outage never causes the orchestrator to restart ' +
      'an otherwise healthy process.',
  })
  @ApiResponse({ status: 200, description: 'Process is alive' })
  live(@Res() res: Response) {
    return res.status(HttpStatus.OK).json({
      status: 'up',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Probes the critical dependencies (database and cache) in parallel. Returns 200 when ' +
      'every dependency is up and 503 when any is down, with per-dependency status, latency ' +
      'and error detail under `services`.',
  })
  @ApiResponse({ status: 200, description: 'All critical dependencies are reachable' })
  @ApiResponse({ status: 503, description: 'At least one critical dependency is unreachable' })
  async ready(@Res() res: Response) {
    const [database, cache] = await Promise.all([
      this.dbIndicator.check('database'),
      this.redisIndicator.checkHealth(),
    ]);

    const services = {
      database: unwrap(database, 'database'),
      cache,
    };

    const isReady = Object.values(services).every((s) => s.status === 'up');
    const statusCode = isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json({
      status: isReady ? 'up' : 'down',
      timestamp: new Date().toISOString(),
      services,
    });
  }

  @Get('liveness')
  @ApiOperation({ summary: 'Application liveness check' })
  @ApiResponse({ status: 200, description: 'Application is alive' })
  getLiveness() {
    return {
      status: 'up',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Application readiness check' })
  @ApiResponse({ status: 200, description: 'Application is ready' })
  @ApiResponse({ status: 503, description: 'Application is not ready' })
  async getReadiness(@Res() res: Response) {
    // The database indicator is a Terminus health indicator, so it reports
    // `{ database: { status, ...details } }`; unwrap it to the same flat shape
    // the other dependencies use.
    const [database, redisHealth, stellarHealth, migrationHealth] = await Promise.all([
      this.dbIndicator.check('database'),
      this.redisIndicator.checkHealth(),
      this.stellarIndicator.checkHealth(),
      this.migrationIndicator.checkHealth(),
    ]);

    const services = {
      database: unwrap(database, 'database'),
      redis: redisHealth,
      stellar: stellarHealth,
      migrations: migrationHealth,
    };

    const isHealthy = Object.values(services).every((s) => s.status === 'up');
    const statusCode = isHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json({
      status: isHealthy ? 'up' : 'down',
      timestamp: new Date().toISOString(),
      services,
    });
  }

  @Get('database')
  @ApiOperation({ summary: 'Database connectivity check' })
  @ApiResponse({ status: 200, description: 'Database is reachable' })
  @ApiResponse({ status: 503, description: 'Database is unreachable' })
  async getDatabase(@Res() res: Response) {
    const database = unwrap(await this.dbIndicator.check('database'), 'database');

    const isUp = database.status === 'up';
    const statusCode = isUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json(database);
  }

  @Get('redis')
  @ApiOperation({ summary: 'Redis connectivity check' })
  @ApiResponse({ status: 200, description: 'Redis is reachable' })
  @ApiResponse({ status: 503, description: 'Redis is unreachable' })
  async getRedis(@Res() res: Response) {
    const redis = await this.redisIndicator.checkHealth();

    const isUp = redis.status === 'up';
    const statusCode = isUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json(redis);
  }

  @Get()
  @ApiOperation({ summary: 'Application health check' })
  @ApiResponse({ status: 200, description: 'Application is healthy' })
  @ApiResponse({ status: 503, description: 'Application is degraded or unhealthy' })
  async check(@Res() res: Response) {
    return this.getReadiness(res);
  }
}

/**
 * Flattens a Terminus `HealthIndicatorResult` entry keyed by `key` into the flat
 * per-dependency report the readiness payload uses. Terminus exposes the failure
 * detail as a free-form `message`; the payload has always exposed a single
 * `error` string, so the two are reconciled here.
 */
function unwrap(result: HealthIndicatorResult, key: string): ReadinessServiceReport {
  const entry = result[key] as
    | { status: 'up' | 'down'; timestamp?: string; error?: string; message?: string }
    | undefined;

  if (!entry) {
    return {
      status: 'down',
      timestamp: new Date().toISOString(),
      error: 'Health indicator returned no result',
    };
  }

  const { message, error, ...details } = entry;
  return {
    ...details,
    status: entry.status,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    ...(message ?? error ? { error: message ?? error } : {}),
  };
}

/**
 * BullMQ queue diagnostics. Separate from `HealthController` so the queue
 * internals stay protected: this controller is NOT marked `@Public()` and
 * requires an authenticated OWNER, ADMIN, DEVELOPER or AUDITOR.
 */
@ApiTags('health')
@Controller('health')
@SkipAudit()
@SkipThrottle({ api: true, auth: true })
@SkipPublicRateLimit()
export class QueuesHealthController {
  constructor(private readonly bullmqHealthIndicator: BullMQHealthIndicator) {}

  @Get('queues')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER, UserRole.AUDITOR)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'BullMQ queue health check',
    description:
      'Inspects every registered BullMQ queue (notifications, webhooks, ' +
      'stellar-sync, analytics, reports, outbox-events, stellar-fee-bump, ' +
      'transactions, risk-analysis, dead-letter, audit-cleanup, audit) and ' +
      'returns waiting/active/failed/delayed/completed/paused job counts plus ' +
      'Redis connectivity. Used by Kubernetes probes and dashboards to monitor ' +
      'asynchronous worker health.',
  })
  @ApiResponse({ status: 200, description: 'Per-queue job counts and Redis connectivity' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Redis unreachable or all queues failing' })
  async checkQueuesHealth(): Promise<QueuesHealthReport> {
    const report = await this.bullmqHealthIndicator.checkHealth();

    if (report.status === 'down') {
      throw new HttpException(
        {
          statusCode: 503,
          message: 'Redis unreachable or all BullMQ queues failing health probes',
          report,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return report;
  }
}
