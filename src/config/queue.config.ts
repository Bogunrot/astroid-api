import { registerAs } from '@nestjs/config';
import { queueEnvSchema, validateEnv } from './env.validation';

export type QueueConfig = {
  prefix: string;
  concurrency: number;
};

export const queueConfig = registerAs('queue', (): QueueConfig => {
  const queueEnv = validateEnv(queueEnvSchema, process.env);
  return {
    prefix: queueEnv.QUEUE_PREFIX,
    concurrency: queueEnv.QUEUE_CONCURRENCY,
  };
});
