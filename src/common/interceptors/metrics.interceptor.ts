import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { MetricsService } from '../../modules/metrics/metrics.service';
import { normalizeRoutePath } from '../../utils/route-normalizer.util';

/**
 * NestJS interceptor that collects Prometheus metrics for all HTTP requests.
 * 
 * Records:
 * - Request duration histograms (in seconds)
 * - Request counters categorized by route, method, and status code
 * - Active request gauges (incremented on entry, decremented on completion)
 * 
 * The /metrics endpoint itself is excluded to prevent self-instrumentation.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MetricsInterceptor.name);
  private activeRequests = 0;

  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // Skip metrics collection for the /metrics endpoint
    if (req.path === '/metrics') {
      return next.handle();
    }

    const startTime = process.hrtime.bigint();
    this.activeRequests++;

    return next.handle().pipe(
      tap({
        next: () => {
          this.recordMetrics(req, res, startTime);
        },
        error: () => {
          this.recordMetrics(req, res, startTime);
        },
        finalize: () => {
          this.activeRequests--;
        },
      }),
    );
  }

  private recordMetrics(req: Request, res: Response, startTime: bigint): void {
    try {
      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      const route = normalizeRoutePath(req.path);
      
      this.metricsService.observeHttpRequest(
        req.method,
        route,
        res.statusCode,
        durationSeconds,
      );
    } catch (error) {
      // Log metric recording errors but don't fail the request
      this.logger.error(
        `Failed to record metrics for ${req.method} ${req.path}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Returns the current number of active requests being processed.
   * This can be used for monitoring system load.
   */
  getActiveRequestCount(): number {
    return this.activeRequests;
  }
}
