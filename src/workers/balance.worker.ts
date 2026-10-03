import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { STELLAR_CLIENT, StellarClient } from '../integrations/stellar';
import { BalanceCacheService } from '../modules/wallets/services/balance-cache.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEventName } from '../events/event-names';
import { Queues } from '../queues/queues.constants';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { runWorkerJob, WorkerJob } from './job-worker';

export interface BalanceSyncJob {
  walletId: string;
  stellarAddress: string;
  network: 'testnet' | 'public' | 'futurenet';
  organizationId: string;
}

/**
 * Background worker that polls Stellar for balance changes and updates the
 * Redis cache. Emits domain events when balances cross critical thresholds.
 *
 * Runs rely on the Stellar integration module to read Horizon; the worker
 * is responsible for caching, threshold detection, and event propagation.
 *
 * Processing latency and outcomes are recorded against the Prometheus registry
 * via `WorkerMetricsService` when available.
 */
@Injectable()
export class BalanceWorker {
  private readonly logger = new Logger(BalanceWorker.name);
  readonly queue = Queues.StellarSync;

  constructor(
    @Inject(STELLAR_CLIENT) private readonly stellarClient: StellarClient,
    private readonly cacheService: BalanceCacheService,
    private readonly eventBus: EventBusService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {}

  async process(job: WorkerJob<BalanceSyncJob>): Promise<{
    address: string;
    balanceCount: number;
    alerts: Array<{ asset: string; balance: string; threshold: number }>;
  }> {
    const { walletId, stellarAddress, network, organizationId } = job.data;

    const execute = async (): Promise<{
      address: string;
      balanceCount: number;
      alerts: Array<{ asset: string; balance: string; threshold: number }>;
    }> => {
      this.logger.log(
        `Syncing balance for ${stellarAddress} on ${network} (wallet ${walletId})`,
      );

      // Fetch live balances from Stellar
      const balances = await this.stellarClient.getBalances(stellarAddress, network);

      // Update cache
      await this.cacheService.set(stellarAddress, network, balances);

      // Check for low-balance thresholds
      const alerts = this.cacheService.checkThresholds(balances);

      // Emit balance updated event
      await this.eventBus.emit(
        DomainEventName.WalletBalanceUpdated,
        {
          walletId,
          stellarAddress,
          network,
          balanceCount: balances.length,
          balances: balances.map((b) => ({
            asset: b.asset,
            balance: b.balance,
            assetType: b.assetType,
          })),
        },
        {
          organizationId,
          aggregateType: 'wallet',
          aggregateId: walletId,
        },
      );

      // Emit low balance alerts if any thresholds are breached
      if (alerts.length > 0) {
        this.logger.warn(
          `Low balance alerts for ${stellarAddress}: ${alerts.map((a) => `${a.asset}=${a.balance}`).join(', ')}`,
        );

        await this.eventBus.emit(
          DomainEventName.BudgetWarning,
          {
            walletId,
            stellarAddress,
            alerts,
          },
          {
            organizationId,
            aggregateType: 'wallet',
            aggregateId: walletId,
          },
        );
      }

      return {
        address: stellarAddress,
        balanceCount: balances.length,
        alerts,
      };
    };

    return runWorkerJob({
      queue: this.queue,
      job,
      logger: this.logger,
      metrics: this.workerMetrics,
      defaultJobName: 'balance-sync',
      handler: execute,
    });
  }
}
