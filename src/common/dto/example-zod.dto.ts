import { z } from 'zod';

export const ExampleZodSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type ExampleZodDto = z.infer<typeof ExampleZodSchema>;
