import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { TransactionRepository } from './transaction.repository';
import { WalletModule } from '../wallets/wallet.module';
import { AgentModule } from '../agents/agent.module';
import { PolicyModule } from '../policies/policy.module';
import { RiskModule } from '../risk/risk.module';
import { BudgetModule } from '../budgets/budget.module';
import { SorobanSimulationService } from './services/soroban-simulation.service';
import { StellarSimulationService } from './services/stellar-simulation.service';
import { StellarModule } from '../stellar/stellar.module';
import { SpendingLimitService } from './spending-limit.service';
import { SpendingLimitGuard } from './guards/spending-limit.guard';

/**
 * Transaction pipeline module. Pulls together wallets, agents, policies, risk
 * and budgets to enforce governance on every payment. Stellar + events are
 * provided globally. Exports the service so the approvals module can execute an
 * approved proposal's transaction.
 */
@Module({
  imports: [WalletModule, AgentModule, PolicyModule, RiskModule, BudgetModule, StellarModule],
  controllers: [TransactionController],
  providers: [
    TransactionService,
    TransactionRepository,
    SorobanSimulationService,
    StellarSimulationService,
    SpendingLimitService,
    SpendingLimitGuard,
  ],
  exports: [TransactionService, SorobanSimulationService, StellarSimulationService, SpendingLimitService],
})
export class TransactionModule {}
