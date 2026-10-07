import { SetMetadata } from '@nestjs/common';

export const AGENT_POLICY_KEY = 'agentPolicy';

/**
 * Decorator to enable agent spending policy enforcement on a route.
 * When applied, the AgentPolicyGuard will validate the transaction
 * against the agent's active spending policies before execution.
 */
export const RequireAgentPolicy = () => SetMetadata(AGENT_POLICY_KEY, true);
