import { PrismaClient } from "@prisma/client";

describe("Prisma schema integrity", () => {
  it("Prisma generated types include all expected models", () => {
    // Type-level check: verify all model delegate types exist in the generated Prisma namespace.
    // We construct the expected model list from the schema and verify compile-time compatibility.
    // This test passes if the file compiles — a Prisma model rename or removal breaks it.
    type ModelNames = keyof Omit<
      InstanceType<typeof PrismaClient>,
      | "$on"
      | "$connect"
      | "$disconnect"
      | "$use"
      | "$executeRaw"
      | "$executeRawUnsafe"
      | "$queryRaw"
      | "$queryRawUnsafe"
      | "$transaction"
      | "$extends"
      | "$metrics"
    >;
    const _user: ModelNames = "user";
    const _account: ModelNames = "account";
    const _session: ModelNames = "session";
    const _transaction: ModelNames = "transaction";
    const _emailFilter: ModelNames = "emailFilter";
    const _syncJob: ModelNames = "syncJob";
    const _reconciliationLog: ModelNames = "reconciliationLog";
    const _asset: ModelNames = "asset";
    const _verificationToken: ModelNames = "verificationToken";

    expect([_user, _account, _session, _transaction, _emailFilter, _syncJob, _reconciliationLog, _asset, _verificationToken]).toHaveLength(9);
  });

  it("Transaction type accepts required fields", () => {
    type TransactionCreateInput = Parameters<
      InstanceType<typeof PrismaClient>["transaction"]["create"]
    >[0]["data"];
    const _check: TransactionCreateInput = {
      user: { connect: { id: "test" } },
      date: new Date(),
      merchant: "Test Merchant",
      amount: 100,
      type: "debit",
      category: "food",
    };
    expect(_check.merchant).toBe("Test Merchant");
  });

  it("EmailFilter composite unique key type_value is available", () => {
    type EmailFilterWhereUniqueInput = Parameters<
      InstanceType<typeof PrismaClient>["emailFilter"]["upsert"]
    >[0]["where"];
    const _check: EmailFilterWhereUniqueInput = {
      type_value: { type: "sender_domain", value: "test.com" },
    };
    expect(_check.type_value?.value).toBe("test.com");
  });
});
