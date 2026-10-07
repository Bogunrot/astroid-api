import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MemoryRepository } from './memory.repository';
import { CreateMemoryInput } from './memory.dto';
import { NotFoundException } from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';

const SORTABLE = ['createdAt', 'risk'];

/**
 * The financial memory: an append-only record of what an agent did and *why*.
 * Powers explainability ("why did the agent pay this?") and search across an
 * agent's decision history.
 */
@Injectable()
export class MemoryService {
  constructor(private readonly repository: MemoryRepository) {}

  create(organizationId: string, input: CreateMemoryInput) {
    return this.repository.create({
      organizationId,
      agentId: input.agentId,
      transactionId: input.transactionId,
      task: input.task,
      reason: input.reason,
      conversationId: input.conversationId,
      policyUsed: input.policyUsed,
      risk: input.risk,
      summary: input.summary,
      metadata: input.metadata as Prisma.InputJsonValue,
    });
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.MemoryRecordWhereInput = { organizationId };
    if (query.search) {
      where.OR = [
        { task: { contains: query.search, mode: 'insensitive' } },
        { reason: { contains: query.search, mode: 'insensitive' } },
        { summary: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.filter) {
      // Filter by agentId when provided.
      where.agentId = query.filter;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string) {
    const record = await this.repository.findById(organizationId, id);
    if (!record) {
      throw new NotFoundException('MemoryRecord', id);
    }
    return record;
  }
}
