import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ZodTypeAny } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';

export function ZodBody(schema: ZodTypeAny) {
  return createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const pipe = new ZodValidationPipe(schema);
    return pipe.transform(request.body, { type: 'body' });
  })();
}
