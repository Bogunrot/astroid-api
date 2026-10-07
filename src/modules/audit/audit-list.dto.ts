import { z } from 'zod';
import { isValidAuditCursor } from './audit-cursor';

export const auditListQuerySchema = z
  .object({
    cursor: z.string().max(256).refine(isValidAuditCursor, 'Invalid cursor').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    actorId: z.string().min(1).max(128).optional(),
    action: z.string().min(1).max(120).optional(),
    resourceId: z.string().min(1).max(128).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: '`to` must be greater than or equal to `from`',
      });
    }
  });

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;