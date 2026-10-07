import { Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationType, Prisma } from '@prisma/client';
import { NotificationRepository } from './notification.repository';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';

const SORTABLE = ['createdAt', 'type', 'read'];

export interface CreateNotificationData {
  organizationId: string;
  userId: string;
  title: string;
  body: string;
  type?: NotificationType;
  channel?: NotificationChannel;
  metadata?: Record<string, unknown>;
}

/**
 * Delivers in-app notifications. Records are created by the listener in response
 * to domain events (budget exceeded, approval required, risk alert, …) and read
 * by users through the dashboard.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly repository: NotificationRepository) {}

  create(data: CreateNotificationData) {
    return this.repository.create({
      organizationId: data.organizationId,
      userId: data.userId,
      title: data.title,
      body: data.body,
      type: data.type ?? NotificationType.INFO,
      channel: data.channel ?? NotificationChannel.DASHBOARD,
      metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
    });
  }

  /** Broadcasts a notification to every active member of an organization. */
  async broadcast(
    organizationId: string,
    payload: Omit<CreateNotificationData, 'organizationId' | 'userId'>,
  ) {
    const users = await this.repository.findActiveUserIds(organizationId);
    if (users.length === 0) {
      return { created: 0 };
    }
    const result = await this.repository.createManyForOrg(
      users.map((user) => ({
        organizationId,
        userId: user.id,
        title: payload.title,
        body: payload.body,
        type: payload.type ?? NotificationType.INFO,
        channel: payload.channel ?? NotificationChannel.DASHBOARD,
        metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
      })),
    );
    return { created: result.count };
  }

  async list(organizationId: string, userId: string, query: PaginationQuery) {
    const where: Prisma.NotificationWhereInput = { organizationId, userId };
    if (query.filter === 'unread') {
      where.read = false;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async unreadCount(organizationId: string, userId: string) {
    const count = await this.repository.countUnread(organizationId, userId);
    return { unread: count };
  }

  async markRead(organizationId: string, userId: string, ids: string[]) {
    const result = await this.repository.markRead(organizationId, userId, ids);
    return { updated: result.count };
  }

  async markAllRead(organizationId: string, userId: string) {
    const result = await this.repository.markAllRead(organizationId, userId);
    return { updated: result.count };
  }
}
