const mockEmailScanRunFindFirst = jest.fn();
const mockEmailScanRunCreate = jest.fn();
const mockUserEmailFilterCreate = jest.fn();
const mockEmailFilterVersionCreate = jest.fn();
const mockUserEmailFilterUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...args),
    emailScanRun: {
      findFirst: (...args: unknown[]) => mockEmailScanRunFindFirst(...args),
    },
  },
}));

import { createScanRun } from "@/lib/scan/scanCreateService";
import type { CreateScanRequest } from "@/lib/scan/types";
import { Prisma } from "@prisma/client";

const baseRequest: CreateScanRequest = {
  userId: "user-1",
  gmailAccountId: "acct-1",
  clientRequestId: "client-req-001",
  filterName: "Test Filter",
  gmailQuery: "from:bank",
  fromDate: new Date("2026-01-01"),
  toDate: new Date("2026-07-01"),
};

function makeTxClient() {
  return {
    userEmailFilter: {
      create: mockUserEmailFilterCreate,
      update: mockUserEmailFilterUpdate,
    },
    emailFilterVersion: { create: mockEmailFilterVersionCreate },
    emailScanRun: { create: mockEmailScanRunCreate },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmailScanRunFindFirst.mockResolvedValue(null);
  mockUserEmailFilterCreate.mockResolvedValue({ id: "filter-1" });
  mockEmailFilterVersionCreate.mockResolvedValue({ id: "version-1" });
  mockUserEmailFilterUpdate.mockResolvedValue({ id: "filter-1" });
  mockEmailScanRunCreate.mockResolvedValue({ id: "run-new", status: "CREATED" });
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(makeTxClient()),
  );
});

describe("createScanRun", () => {
  it("runs all writes inside a single transaction", async () => {
    await createScanRun(baseRequest);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("creates filter, version, and scan run on first call", async () => {
    const result = await createScanRun(baseRequest);
    expect(result.scanRunId).toBe("run-new");
    expect(result.status).toBe("CREATED");
    expect(result.created).toBe(true);
    expect(mockUserEmailFilterCreate).toHaveBeenCalledTimes(1);
    expect(mockEmailFilterVersionCreate).toHaveBeenCalledTimes(1);
    expect(mockEmailScanRunCreate).toHaveBeenCalledTimes(1);
  });

  it("returns existing scan run when clientRequestId already exists (idempotent)", async () => {
    mockEmailScanRunFindFirst.mockResolvedValue({ id: "run-existing", status: "CREATED" });
    const result = await createScanRun(baseRequest);
    expect(result.scanRunId).toBe("run-existing");
    expect(result.created).toBe(false);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("passes gmailQuery into emailFilterVersion", async () => {
    await createScanRun(baseRequest);
    expect(mockEmailFilterVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gmailQuery: "from:bank" }),
      }),
    );
  });

  it("passes fromDate and toDate into emailScanRun", async () => {
    await createScanRun(baseRequest);
    expect(mockEmailScanRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromDate: new Date("2026-01-01"),
          toDate: new Date("2026-07-01"),
        }),
      }),
    );
  });

  it("sets scanLimit when provided", async () => {
    await createScanRun({ ...baseRequest, scanLimit: 100 });
    expect(mockEmailScanRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scanLimit: 100 }),
      }),
    );
  });

  it("omits scanLimit when not provided", async () => {
    await createScanRun(baseRequest);
    const callArgs = mockEmailScanRunCreate.mock.calls[0][0];
    expect(callArgs.data.scanLimit).toBeUndefined();
  });

  it("returns idempotent result when concurrent request causes P2002 unique constraint error", async () => {
    mockEmailScanRunFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "run-winner", status: "CREATED" });

    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "0.0.0",
      meta: { target: ["userId", "clientRequestId"] },
    });
    mockTransaction.mockRejectedValueOnce(p2002);

    const result = await createScanRun(baseRequest);
    expect(result.scanRunId).toBe("run-winner");
    expect(result.created).toBe(false);
    expect(result.status).toBe("CREATED");
  });
});
