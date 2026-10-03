# Request validation with `ZodValidationPipe`

Every inbound payload in Astroid is validated against a Zod schema before it
reaches a controller method. This document is the convention to follow when
adding or changing an endpoint.

## The rule

Define the schema next to the DTO, then attach the pipe to the `@Body()` or
`@Query()` parameter:

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { createWalletSchema, CreateWalletInput } from './wallet.dto';

@Controller('wallets')
export class WalletController {
  @Post()
  create(
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletInput,
  ) {
    return this.wallets.create(body);
  }
}
```

The pipe is the **only** source of truth for a request payload's shape. Do not
re-validate the same body with `class-validator` inside the service, and do not
reach into `body` without a schema attached.

`ZodValidationPipe` is applied per-parameter rather than registered globally
because each endpoint has a different schema. The global `ValidationPipe` in
`main.ts` still runs and covers the `class-validator` DTOs; the two compose, and
Zod runs first.

## What the pipe guarantees

- **Parsed output, not just validation.** The handler receives the *parsed*
  value, so schema defaults, coercions and transforms are already applied.
  `z.coerce.number().default(1)` means a handler can read `query.page` as a
  number without re-parsing.
- **Unknown keys are stripped.** A plain `z.object({...})` drops properties the
  schema does not declare, so a client cannot smuggle extra fields into a
  service call. Use `.strict()` when an unexpected key should be a hard error
  rather than a silent drop.
- **Nested paths are preserved.** Failures are reported with dot-joined paths
  (`configuration.threshold`) in the canonical `ValidationErrorDetail` shape
  shared with every other validator in the codebase.

## Failure shape

A failed parse throws `ValidationException`, which the global
`AllExceptionsFilter` renders in the standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "path": "email", "message": "Invalid email" },
      { "path": "limitAmount", "message": "Number must be greater than or equal to 0" }
    ]
  },
  "requestId": "req_..."
}
```

`details` is always `ValidationErrorDetail[]` (`{ path, message }`), so clients
can render field-level errors without special-casing individual endpoints.

> The pipe throws `ZodValidationException`, a `BadRequestException` subclass
> that also carries the canonical `VALIDATION_ERROR` code and the structured
> `details` array. Extending `BadRequestException` keeps the rejection inside
> Nest's standard HTTP exception flow (framework code, guards and tests can
> `instanceof`-check it), while the preserved code and details stop the error
> envelope from degrading to a generic 400 message.

## Localized error messages

The pipe is internationalization-ready. Pass `customMessages` to override
messages by path (`'limitAmount'`), by path plus issue code
(`'email.invalid_string'`), or by code alone:

```ts
@Body(
  new ZodValidationPipe(createWalletSchema, {
    customMessages: { limitAmount: 'El límite debe ser mayor que cero' },
  }),
)
body: CreateWalletInput
```

For full control — or to pull messages from a translation catalog — pass
`errorMap`, which receives the raw `ZodError`:

```ts
@Body(
  new ZodValidationPipe(createWalletSchema, {
    errorMap: (error) => translateIssues(error.issues, reqLang),
  }),
)
body: CreateWalletInput
```

## Checklist for a new endpoint

1. Add the schema and its inferred input type to the module's `*.dto.ts`.
2. Attach `new ZodValidationPipe(schema)` to the `@Body()` / `@Query()` parameter.
3. Use the inferred input type as the handler parameter type — do not redeclare it.
4. Confirm the endpoint's controller spec covers the rejected cases
   (missing required field, malformed value, unexpected property).
5. `npm run typecheck` and `npm test` must pass.
