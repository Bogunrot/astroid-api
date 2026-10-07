import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service';
import {
  WEBHOOK_DELIVERY_FAILED_ACTION,
  WebhookAuditService,
  WebhookDeliveryFailure,
} from './webhook-audit.service';

const FAILURE: WebhookDeliveryFailure = {
  webhookId: 'wh-1',
  organizationId: 'org-1',
  url: 'https://example.com/hook',
  eventName: 'transaction.completed',
  eventId: 'event-1',
  attemptsMade: 5,
  failedReason: 'HTTP 503: Service Unavailable',
  responseStatus: 503,
};

describe('WebhookAuditService', () => {
  let record: ReturnType<typeof vi.fn>;
  let service: WebhookAuditService;

  beforeEach(() => {
    record = vi.fn().mockResolvedValue({ id: 'audit-1' });
    service = new WebhookAuditService({ record } as unknown as AuditService);
  });

  it('appends a WEBHOOK_DELIVERY_FAILED entry for a dead-lettered delivery', async () => {
    await service.recordTerminalFailure(FAILURE);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: null,
        action: WEBHOOK_DELIVERY_FAILED_ACTION,
        entity: 'Webhook',
        entityId: 'wh-1',
        newValue: expect.objectContaining({
          url: 'https://example.com/hook',
          eventName: 'transaction.completed',
          eventId: 'event-1',
          attemptsMade: 5,
          responseStatus: 503,
          failedReason: 'HTTP 503: Service Unavailable',
          deadLettered: true,
        }),
      }),
    );
  });

  it('defaults the optional event/response fields to null', async () => {
    await service.recordTerminalFailure({
      webhookId: 'wh-2',
      organizationId: 'org-2',
      url: 'https://example.com/hook',
      attemptsMade: 5,
      failedReason: 'socket hang up',
    });

    const { newValue } = record.mock.calls[0][0];
    expect(newValue.eventName).toBeNull();
    expect(newValue.eventId).toBeNull();
    expect(newValue.responseStatus).toBeNull();
  });

  it('never throws when the audit write fails, so the worker stays alive', async () => {
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    record.mockRejectedValue(new Error('audit table down'));

    await expect(service.recordTerminalFailure(FAILURE)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('Failed to audit webhook wh-1 delivery failure'),
    );
    logger.mockRestore();
  });
});
