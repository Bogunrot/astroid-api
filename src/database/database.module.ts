import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaTransactionService } from './prisma-transaction.service';

/**
 * Global database module. Provides a single shared PrismaService to every
 * repository across the application, plus the transaction manager services use
 * to make multi-step writes atomic.
 */
@Global()
@Module({
  providers: [PrismaService, PrismaTransactionService],
  exports: [PrismaService, PrismaTransactionService],
})
export class DatabaseModule {}
