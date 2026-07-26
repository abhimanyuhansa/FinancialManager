# ParseTemplate replay reconciliation restore notes

These three reconciliation migrations preserve the existing historical migration files and
their recorded SHA-256 checksums.

They create no persistent business table or business data. On a clean replay, the first two
migrations create and remove an empty transient bootstrap. The final migration normalizes the
same `ParseTemplate.updatedAt` default and index name produced by the historical applied order.
On an already-migrated database, all three migrations validate state and avoid domain-data
mutation.

Do not remove individual reconciliation rows from `_prisma_migrations` or partially roll back
this sequence. If reconciliation must be reversed, restore the pre-deployment database snapshot
and the prior application commit together, then verify all historical migration checksums before
accepting traffic.
