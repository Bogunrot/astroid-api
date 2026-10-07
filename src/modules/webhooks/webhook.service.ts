import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WebhookRepository } from './webhook.repository';
import { CreateWebhookInput, UpdateWebhookInput } from './webhook.dto';
import { NotFoundException } from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { generateToken } from '../../utils/crypto.util';

const SORTABLE = ['createdAt', 'url'];

/** Strips the signing secret from a webhook before returning it to a client. */
function redact<T extends { secret?: string }>(webhook: T): Omit<T, 'secret'> {
  const { secret: _secret, ...safe } = webhook;
  return safe;
}

/**
 * Manages outbound webhook subscriptions. Each webhook has an HMAC signing
 * secret that is returned ONLY when it is created or rotated — it is never
 * logged and never included in any list/get response afterwards.
 */
@Injectable()
export class WebhookService {
  constructor(private readonly repository: WebhookRepository) {}

  async create(organizationId: string, input: CreateWebhookInput) {
    const secret = `whsec_${generateToken(24)}`;
    const webhook = await this.repository.create({
      organizationId,
      url: input.url,
      secret,
      events: input.events,
      enabled: input.enabled,
    });
    // Return the secret exactly once, alongside the redacted record.
    return { ...redact(webhook), secret };
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.WebhookWhereInput = { organizationId };
    if (query.search) {
      where.url = { contains: query.search, mode: 'insensitive' };
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string) {
    const webhook = await this.repository.findById(organizationId, id);
    if (!webhook) {
      throw new NotFoundException('Webhook', id);
    }
    return webhook;
  }

  async get(organizationId: string, id: string) {
    return redact(await this.getOrThrow(organizationId, id));
  }

  async update(organizationId: string, id: string, input: UpdateWebhookInput) {
    await this.getOrThrow(organizationId, id);
    const webhook = await this.repository.update(id, {
      url: input.url,
      events: input.events,
      enabled: input.enabled,
    });
    return redact(webhook);
  }

  /** Rotates the signing secret; the new secret is returned exactly once. */
  async rotateSecret(organizationId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    const secret = `whsec_${generateToken(24)}`;
    const webhook = await this.repository.update(id, { secret });
    return { ...redact(webhook), secret };
  }

  async remove(organizationId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    await this.repository.delete(id);
    return { id, deleted: true };
  }
}
