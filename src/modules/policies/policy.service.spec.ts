import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PolicyService } from './policy.service';

describe('PolicyService velocity limit delegation', () => {
  let service: PolicyService;
  let checkVelocityLimit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    checkVelocityLimit = vi.fn().mockResolvedValue(undefined);
    service = new PolicyService(
      { checkVelocityLimit } as never,
      {} as never,
      { emit: vi.fn() } as never,
    );
  });

  it('forwards the transaction governance arguments to the spending policy service', async () => {
    await service.checkVelocityLimit('org-1', 'agent-1', 3, 'XLM', 'user-1');
    expect(checkVelocityLimit).toHaveBeenCalledWith('agent-1', 3, 'XLM');
  });
});
