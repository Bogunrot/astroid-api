import { Controller, Post, Body } from '@nestjs/common';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { ExampleZodSchema, ExampleZodDto } from '../dto/example-zod.dto';

@Controller('example-zod')
export class ExampleZodController {
  @Post()
  create(@Body(new ZodValidationPipe(ExampleZodSchema)) dto: ExampleZodDto) {
    return {
      success: true,
      data: dto,
    };
  }
}
