import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { Queues } from '../../../queues/queues.constants';
import { ConfigService } from '@nestjs/config';

@Processor(Queues.AuditCleanup)
export class AuditCleanupQueue extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(AuditCleanupQueue.name);

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Starting audit cleanup job ${job.id}`);
    const chunkLimit = 1000;
    const defaultRetentionDays = this.configService.get<number>('AUDIT_RETENTION_DAYS', 90);

    const startTime = Date.now();
    let totalDeleted = 0;

    try {
      // Find all active organizations
      const orgs = await this.prisma.organization.findMany({ select: { id: true } });
      
      for (const org of orgs) {
        // dynamic retention could be read from org.metadata if it existed
        // falling back to default
        const retentionDays = defaultRetentionDays;
        
        const retentionDate = new Date();
        retentionDate.setDate(retentionDate.getDate() - retentionDays);

        let _orgDeleted = 0;
        while (true) {
          const logsToDelete = await this.prisma.auditLog.findMany({
            where: { organizationId: org.id, createdAt: { lt: retentionDate } },
            select: { id: true },
            take: chunkLimit,
          });

          if (logsToDelete.length === 0) {
            break;
          }

          const ids = logsToDelete.map(l => l.id);
          const { count } = await this.prisma.auditLog.deleteMany({
            where: { id: { in: ids } },
          });

          _orgDeleted += count;
          totalDeleted += count;

          if (count < chunkLimit) {
            break; // Last chunk
          }
        }
      }

      // Cleanup system logs (no organization)
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - defaultRetentionDays);
      while(true) {
         const logsToDelete = await this.prisma.auditLog.findMany({
            where: { createdAt: { lt: retentionDate } },
            select: { id: true },
            take: chunkLimit,
          });
          if (logsToDelete.length === 0) break;
          const ids = logsToDelete.map(l => l.id);
          const { count } = await this.prisma.auditLog.deleteMany({
            where: { id: { in: ids } },
          });
          totalDeleted += count;
          if (count < chunkLimit) break;
      }

      const durationMs = Date.now() - startTime;
      await this.prisma.cleanupJobLog.create({
        data: {
          jobName: 'audit-cleanup',
          recordsDeleted: totalDeleted,
          durationMs,
          status: 'SUCCESS',
        }
      });
      
      this.logger.log(`Audit cleanup completed: ${totalDeleted} records deleted in ${durationMs}ms`);
      
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = (error as Error).message;
      
      await this.prisma.cleanupJobLog.create({
        data: {
          jobName: 'audit-cleanup',
          recordsDeleted: totalDeleted,
          durationMs,
          status: 'FAILED',
          error: errorMessage,
        }
      });
      
      this.logger.error(`Audit cleanup failed: ${errorMessage}`);
      throw error;
    }
  }
}
