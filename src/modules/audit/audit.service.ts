import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditRepository, CreateAuditLogData } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { CursorPaginated } from '../../common/interfaces/api-response.interface';
import { AuditListQuery } from './audit-list.dto';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor';
import { ExportAuditLogsQuery, StreamAuditLogsQuery } from './audit-export.dto';
import { sanitizeAuditPayload } from '../../common/helpers/audit-sanitizer';

/** An audit row as returned by `AuditRepository.exportLogs`, with its joined user. */
type ExportedAuditLog = Prisma.AuditLogGetPayload<{
  include: { user: { select: { id: true; email: true; name: true } } };
}>;

/**
 * Writes and queries the immutable audit trail. Records Who / When / Where /
 * Why / Old / New for every important action. Never updates or deletes.
 * Integrates cryptographic hash chaining for tamper-evident audit history.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly hashService: AuditHashService,
  ) {}

  async record(data: CreateAuditLogData) {
    const previousHash = await this.hashService.getLatestHash(data.organizationId);
    const createdAt = new Date();

    const hashResult = this.hashService.computeEntryHash(
      {
        organizationId: data.organizationId,
        userId: data.userId,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId,
        oldValue: data.oldValue,
        newValue: data.newValue,
        ipAddress: data.ipAddress,
        device: data.device,
        createdAt,
      },
      previousHash,
    );

    return this.repository.create({
      ...data,
      requestId: data.requestId ?? null,
      previousHash: hashResult.previousHash,
      hash: hashResult.hash,
    });
  }

  /** Cursor-paginated audit log listing, newest first. */
  async list(organizationId: string, query: AuditListQuery): Promise<CursorPaginated<ExportedAuditLog>> {
    const where = this.buildFilterWhere(organizationId, query);
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : undefined;
    const take = query.limit + 1;

    const rows = (await this.repository.findPage(where, cursor, take)) as ExportedAuditLog[];
    const hasNext = rows.length > query.limit;
    const items = hasNext ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasNext && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return new CursorPaginated(items, { limit: query.limit, hasNext, nextCursor });
  }

  async export(organizationId: string, query: ExportAuditLogsQuery) {
    const where = this.buildFilterWhere(organizationId, query);
    const limit = Math.min(query.limit ?? 100, 1000);
    const records = await this.repository.exportLogs(where, limit, query.cursor);

    let nextCursor: string | null = null;
    let items = records;
    if (records.length > limit) {
      items = records.slice(0, limit);
      nextCursor = items[items.length - 1]?.id ?? null;
    }
    const sanitized = items.map((item) => this.sanitizeRecord(item));

    if (query.format === 'csv') {
      const csv = this.formatAsCsv(sanitized);
      return { format: 'csv', data: csv, count: sanitized.length, nextCursor };
    }

    return {
      format: 'json',
      data: sanitized,
      count: sanitized.length,
      nextCursor,
    };
  }

  /**
   * Streams an export in bounded batches so large exports never load the
   * full result set into memory. Yields Buffer chunks: a JSON array
   * (one record per chunk, wrapped by `[`/`]`) or raw CSV rows.
   */
  async *streamExport(organizationId: string, query: StreamAuditLogsQuery): AsyncGenerator<Buffer> {
    const where = this.buildFilterWhere(organizationId, query);
    const stream = this.repository.streamLogs(where, query.batchSize, query.cursor);

    if (query.format === 'csv') {
      const headers = [
        'id',
        'organizationId',
        'userId',
        'userEmail',
        'action',
        'entity',
        'entityId',
        'ipAddress',
        'device',
        'oldValue',
        'newValue',
        'createdAt',
      ];
      yield Buffer.from(`${headers.join(',')}\n`);
      for await (const record of stream) {
        const row = this.formatCsvRow(this.sanitizeRecord(record));
        yield Buffer.from(`${row}\n`);
      }
      return;
    }

    let first = true;
    yield Buffer.from('[');
    for await (const record of stream) {
      const sanitized = this.sanitizeRecord(record);
      yield Buffer.from(`${first ? '' : ','}${JSON.stringify(sanitized)}`);
      first = false;
    }
    yield Buffer.from(']');
  }

  /** Builds the shared tenant + filter predicate used by list, export and streamExport. */
  private buildFilterWhere(
    organizationId: string,
    query: {
      userId?: string;
      actionType?: string;
      agentId?: string;
      severity?: string;
      startDate?: string;
      endDate?: string;
      actorId?: string;
      action?: string;
      resourceId?: string;
      from?: string;
      to?: string;
    },
  ): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = { organizationId };
    const andConditions: Prisma.AuditLogWhereInput[] = [];

    if (query.userId) where.userId = query.userId;
    if (query.actorId) where.userId = query.actorId;
    if (query.actionType) where.action = query.actionType;
    if (query.action) where.action = query.action;
    if (query.resourceId) where.entityId = query.resourceId;

    if (query.agentId) {
      andConditions.push({
        OR: [
          { entityId: query.agentId },
          { oldValue: { path: ['agentId'], equals: query.agentId } },
          { newValue: { path: ['agentId'], equals: query.agentId } },
        ],
      });
    }

    if (query.severity) {
      andConditions.push({
        OR: [
          { oldValue: { path: ['severity'], equals: query.severity } },
          { newValue: { path: ['severity'], equals: query.severity } },
        ],
      });
    }

    const gte = query.startDate ?? query.from;
    const lte = query.endDate ?? query.to;
    if (gte || lte) {
      where.createdAt = {};
      if (gte) where.createdAt.gte = new Date(gte);
      if (lte) where.createdAt.lte = new Date(lte);
    }

    if (andConditions.length > 0) where.AND = andConditions;

    return where;
  }

  /** Redacts sensitive payload fields from a raw audit row before it leaves the service. */
  private sanitizeRecord(record: ExportedAuditLog): ExportedAuditLog {
    return {
      ...record,
      oldValue: sanitizeAuditPayload(record.oldValue),
      newValue: sanitizeAuditPayload(record.newValue),
    };
  }

  private formatCsvRow(r: ExportedAuditLog): string {
    const escapeCsvField = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    return [
      escapeCsvField(r.id),
      escapeCsvField(r.organizationId),
      escapeCsvField(r.userId),
      escapeCsvField(r.user?.email ?? ''),
      escapeCsvField(r.action),
      escapeCsvField(r.entity),
      escapeCsvField(r.entityId),
      escapeCsvField(r.ipAddress),
      escapeCsvField(r.device),
      escapeCsvField(r.oldValue),
      escapeCsvField(r.newValue),
      escapeCsvField(r.createdAt ? new Date(r.createdAt).toISOString() : ''),
    ].join(',');
  }

  formatAsCsv(records: ExportedAuditLog[]): string {
    const headers = [
      'id',
      'organizationId',
      'userId',
      'userEmail',
      'action',
      'entity',
      'entityId',
      'ipAddress',
      'device',
      'oldValue',
      'newValue',
      'createdAt',
    ];
    const lines = [headers.join(','), ...records.map((r) => this.formatCsvRow(r))];
    return lines.join('\n');
  }

  findById(organizationId: string, id: string) {
    return this.repository.findById(organizationId, id);
  }

  /**
   * Verifies the integrity of the entire audit chain for an organization.
   * Returns detailed information about chain validity.
   */
  async verifyIntegrity(organizationId: string) {
    return this.hashService.verifyChainIntegrity(organizationId);
  }

  /**
   * Verifies the integrity of a single audit log entry.
   */
  async verifyEntryIntegrity(entryId: string, organizationId: string) {
    return this.hashService.verifyEntryIntegrity(entryId, organizationId);
  }
}
