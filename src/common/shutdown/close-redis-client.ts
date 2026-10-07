import Redis from 'ioredis';

/**
 * Closes an ioredis client gracefully: `QUIT` lets pending replies arrive
 * before the socket closes. Clients that never connected (lazyConnect) or are
 * already closed are simply disconnected, so this is safe to call repeatedly.
 */
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') {
    return;
  }
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
