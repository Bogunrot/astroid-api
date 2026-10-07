import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { Job } from 'bullmq';

@Processor('transactions')
export class TransactionWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(TransactionWorker.name);

  async process(job: Job): Promise<void> {
    this.logger.debug(`Processing transaction job ${job.id}`);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.worker) {
      this.worker.on('failed', (job, err) => {
        this.logger.error(`Job ${job?.id} failed: ${err.message}`);
      });
      this.worker.on('error', (err) => {
        this.logger.error(`Worker error: ${err.message}`);
      });
      this.worker.on('stalled', (jobId) => {
        this.logger.warn(`Job ${jobId} stalled`);
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('TransactionWorker closed successfully');
    }
  }
}
