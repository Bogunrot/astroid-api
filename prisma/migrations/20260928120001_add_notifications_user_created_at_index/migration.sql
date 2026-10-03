-- CreateIndex
-- Notification inbox: `WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT n`
-- (NotificationService.list). The single-column userId index finds the rows
-- but must sort all of them to page; this index returns them pre-ordered.
--
-- Built CONCURRENTLY so writes are never blocked. Postgres forbids that inside
-- a transaction, and Prisma runs a multi-statement migration as one, so this
-- file must contain exactly this one statement.
CREATE INDEX CONCURRENTLY "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");
