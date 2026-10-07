import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { closeRedisClient } from './close-redis-client';

function client(status: string, quit: () => Promise<unknown> = async () => 'OK') {
  return { status, quit: vi.fn(quit), disconnect: vi.fn() };
}

describe('closeRedisClient', () => {
  it('sends QUIT to a connected client so pending replies are delivered', async () => {
    const redis = client('ready');

    await closeRedisClient(redis as unknown as Redis);

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it.each(['wait', 'connecting', 'reconnecting'])(
    'disconnects a client in the %s state without QUIT',
    async (status) => {
      const redis = client(status);

      await closeRedisClient(redis as unknown as Redis);

      expect(redis.quit).not.toHaveBeenCalled();
      expect(redis.disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('is a no-op for a client that is already closed', async () => {
    const redis = client('end');

    await closeRedisClient(redis as unknown as Redis);

    expect(redis.quit).not.toHaveBeenCalled();
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it('falls back to disconnect when QUIT fails', async () => {
    const redis = client('ready', async () => {
      throw new Error('Connection is closed.');
    });

    await expect(closeRedisClient(redis as unknown as Redis)).resolves.toBeUndefined();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
