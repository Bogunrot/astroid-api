import { Module } from '@nestjs/common';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';
import { SpendingPolicyService } from './spending-policy.service';
import { SpendingPolicyRepository } from './spending-policy.repository';
import { PolicyEngine } from './policy.engine';
import { PolicyOverrideCleanupService } from './services/policy-override-cleanup.service';
import { AgentPolicyGuard } from './guards/agent-policy.guard';

/**
 * Policy module. Exports the service + engine so the transactions module can
 * evaluate intents during the payment pipeline.
 *
 * Persistence is layered: `SpendingPolicyService` owns spending-policy
 * validation and enforcement, and delegates every Prisma call to
 * `SpendingPolicyRepository`.
 */
@Module({
  controllers: [PolicyController],
  providers: [
    PolicyService,
    SpendingPolicyService,
    SpendingPolicyRepository,
    PolicyEngine,
    PolicyOverrideCleanupService,
    AgentPolicyGuard,
  ],
  exports: [
    PolicyService,
    SpendingPolicyService,
    PolicyEngine,
    PolicyOverrideCleanupService,
    AgentPolicyGuard,
  ],
})
export class PolicyModule {}
