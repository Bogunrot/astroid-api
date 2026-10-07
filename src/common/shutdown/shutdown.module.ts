import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ShutdownCoordinator } from './shutdown-coordinator.service';

/**
 * Global graceful-shutdown infrastructure. Providers that own connections
 * inject {@link ShutdownCoordinator} and register how to close them; `main.ts`
 * installs the signal handlers.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [ShutdownCoordinator],
  exports: [ShutdownCoordinator],
})
export class ShutdownModule {}
