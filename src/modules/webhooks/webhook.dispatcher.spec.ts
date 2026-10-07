import { describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookRepository } from './webhook.repository';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';

describe('WebhookDispatcher', () => {
  it('queues envelope deliveries with stable event identity and no signing secret', async () => {
    const queueDelivery = vi.fn().mockResolvedValue(undefined);
    const webhook = {
      id: 'wh-1',
      organizationId: 'org-1',
      url: 'https://example.com/hook',
      secret: 'must-not-enter-job',
    };
    const repository = {
      findEnabledForEvent: vi.fn().mockResolvedValue([webhook]),
    };
    const dispatcher = new WebhookDispatcher(
      repository as unknown as WebhookRepository,
      { queueDelivery } as unknown as WebhookDeliveryService,
    );
    const envelope: DomainEventEnvelope = {
      eventId: 'evt-stable-1',
      name: 'budget.exceeded',
      organizationId: 'org-1',
      aggregateType: 'Budget',
      aggregateId: 'budget-1',
      requestId: 'req-1',
      correlationId: 'corr-1',
      payload: { budgetId: 'budget-1' },
      occurredAt: new Date('2026-09-29T12:00:00.000Z'),
    };

    await dispatcher.dispatch(envelope);

    expect(repository.findEnabledForEvent).toHaveBeenCalledWith('org-1', 'budget.exceeded');
    expect(queueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      webhookId: 'wh-1',
      organizationId: 'org-1',
      eventId: 'evt-stable-1',
      eventName: 'budget.exceeded',
      payload: {
        event: 'budget.exceeded',
        occurredAt: envelope.occurredAt,
        aggregateType: 'Budget',
        aggregateId: 'budget-1',
        data: { budgetId: 'budget-1' },
      },
    }));
    expect(queueDelivery.mock.calls[0][0]).not.toHaveProperty('secret');
  });
});