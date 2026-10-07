import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';
import { AuditCursor } from './audit-cursor';

export interface CreateAuditLogData {
  organizationId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  device?: string | null;
  requestId?: string | null;
  sourceEventId?: string | null;
  createdAt?: Date;
  previousHash?: string | null;
  hash?: string | null;
}

/** Persistence for the append-only audit log. Writes and reads only — no updates. */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateAuditLogData) {
    const create = {
      organizationId: data.organizationId,
      userId: data.userId ?? null,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId ?? null,
      oldValue: data.oldValue,
      newValue: data.newValue,
      ipAddress: data.ipAddress ?? null,
      device: data.device ?? null,
      requestId: data.requestId ?? null,
      sourceEventId: data.sourceEventId ?? null,
      previousHash: data.previousHash ?? null,
      hash: data.hash ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    };

    if (data.sourceEventId) {
      return this.prisma.auditLog.upsert({
        where: { sourceEventId: data.sourceEventId },
        create,
        update: {},
      });
    }

    return this.prisma.auditLog.create({ data: create });
  }

  async findManyAndCount(where: Prisma.AuditLogWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, ...pagination }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total };
  }

  findPage(where: Prisma.AuditLogWhereInput, cursor: AuditCursor | undefined, limit: number) {
    const cursorWhere: Prisma.AuditLogWhereInput | undefined = cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : undefined;

    return this.prisma.auditLog.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async exportLogs(
    where: Prisma.AuditLogWhereInput,
    limit: number,
    cursor?: string,
  ) {
    return this.prisma.auditLog.findMany({
      where,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }

  /**
   * Reads audit rows in bounded batches so exports do not load the full result
   * set into memory. The last row id is used as the next Prisma cursor.
   */
  async *streamLogs(
    where: Prisma.AuditLogWhereInput,
    batchSize: number,
    cursor?: string,
  ): AsyncGenerator<Prisma.AuditLogGetPayload<{
    include: { user: { select: { id: true; email: true; name: true } } };
  }>> {
    let nextCursor = cursor;

    while (true) {
      const records = await this.prisma.auditLog.findMany({
        where,
        take: batchSize,
        ...(nextCursor ? { cursor: { id: nextCursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      });

      if (records.length === 0) return;

      yield* records;
      if (records.length < batchSize) return;
      nextCursor = records[records.length - 1].id;
    }
  }

  findById(organizationId: string, id: string) {
    return this.prisma.auditLog.findFirst({ where: { id, organizationId } });
  }
}
