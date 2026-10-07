import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../common/constants/headers';

@Injectable()
export class StructuredRequestLoggingMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      req.log.info(
        {
          requestId: req.id ?? req.headers[REQUEST_ID_HEADER],
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs,
        },
        'HTTP request completed',
      );
    });

    next();
  }
}
