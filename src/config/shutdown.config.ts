import { registerAs } from '@nestjs/config';
import { shutdownEnvSchema, validateEnv } from './env.validation';

export type ShutdownConfig = {
  /** Time in-flight HTTP requests and BullMQ jobs get to finish on shutdown. */
  gracePeriodMs: number;
};

export const shutdownConfig = registerAs('shutdown', (): ShutdownConfig => {
  const env = validateEnv(shutdownEnvSchema, process.env);
  return {
    gracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS,
  };
});
