import { Injectable } from '@nestjs/common';
import { Budget, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

type BudgetQueryClient = Pick<PrismaService, 'budget'> | Prisma.TransactionClient;

/**
 * Client accepted by the multi-statement writes below. Defaults to the shared
 * {@link PrismaService}, but callers running inside a
 * `PrismaTransactionService` unit of work pass the transactional client so the
 * row lock and the update commit or roll back together.
 */
type BudgetWriteClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class BudgetRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.BudgetCreateInput): Promise<Budget> {
    return this.prisma.budget.create({ data });
  }

  async findManyAndCount(where: Prisma.BudgetWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.budget.findMany({ where, ...pagination }),
      this.prisma.budget.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<Budget | null> {
    return this.prisma.budget.findFirst({ where: { id, organizationId, deletedAt: null } });
  }

  findChildren(parentBudgetId: string): Promise<Budget[]> {
    return this.prisma.budget.findMany({
      where: { parentBudgetId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  update(id: string, data: Prisma.BudgetUpdateInput): Promise<Budget> {
    return this.prisma.budget.update({ where: { id }, data });
  }

  incrementSpent(id: string, amount: Prisma.Decimal): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { spent: { increment: amount } },
    });
  }

  /**
   * Locks the budget row (`SELECT … FOR UPDATE`), verifies the reservation fits
   * inside the remaining balance, and applies it — all on `client`.
   *
   * Pass a `Prisma.TransactionClient` to join an existing unit of work; the
   * default keeps this method usable standalone. Note that the lock only
   * protects the caller when it runs inside that transaction, which is why
   * `BudgetService.reserveBudget` always wraps it in one.
   *
   * @throws Error with `NotFoundException` when the budget does not belong to
   * the organization, or `ConflictException: BudgetExceeded` when the
   * reservation would overshoot the limit.
   */
  async reserveBudget(
    organizationId: string,
    id: string,
    amount: Prisma.Decimal,
    client: BudgetWriteClient = this.prisma,
  ): Promise<Budget> {
    const rows = await client.$queryRaw<Budget[]>`SELECT * FROM "budgets" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (!rows || rows.length === 0) {
      throw new Error('NotFoundException');
    }

    const budget = rows[0];
    const spentAfter = new Prisma.Decimal(budget.spent).plus(amount);
    const limit = new Prisma.Decimal(budget.limitAmount);

    if (spentAfter.greaterThan(limit)) {
      throw new Error('ConflictException: BudgetExceeded');
    }

    return client.budget.update({
      where: { id },
      data: { spent: spentAfter },
    });
  }

  softDelete(id: string): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
  }

  findEnabledByAgentId(agentId: string, client: BudgetQueryClient = this.prisma): Promise<Budget[]> {
    return client.budget.findMany({
      where: { agentId, enabled: true, deletedAt: null },
    });
  }
}
