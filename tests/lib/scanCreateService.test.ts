import { createScanRun, type ScanCreateStore } from "@/lib/scan/scanCreateService";
import type { CreateScanRequest } from "@/lib/scan/types";

const baseRequest: CreateScanRequest = {
  userId: "user-1",
  gmailAccountId: "acct-1",
  clientRequestId: "client-req-001",
  filterName: "Test Filter",
  gmailQuery: "from:bank",
  fromDate: new Date("2026-01-01"),
  toDate: new Date("2026-07-01"),
};

function makeMockStore(overrides?: Partial<ScanCreateStore>): ScanCreateStore {
  return {
    emailScanRun: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: "run-new",
        status: "CREATED",
      }),
    },
    userEmailFilter: {
      create: jest.fn().mockResolvedValue({ id: "filter-1" }),
    },
    emailFilterVersion: {
      create: jest.fn().mockResolvedValue({ id: "version-1" }),
    },
    userEmailFilter_setCurrentVersion: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createScanRun", () => {
  it("creates filter, version, and scan run on first call", async () => {
    const store = makeMockStore();
    const result = await createScanRun(baseRequest, store);

    expect(result.scanRunId).toBe("run-new");
    expect(result.status).toBe("CREATED");
    expect(result.created).toBe(true);
    expect(store.userEmailFilter.create).toHaveBeenCalledTimes(1);
    expect(store.emailFilterVersion.create).toHaveBeenCalledTimes(1);
    expect(store.emailScanRun.create).toHaveBeenCalledTimes(1);
  });

  it("returns existing scan run when clientRequestId already exists (idempotent)", async () => {
    const store = makeMockStore({
      emailScanRun: {
        findFirst: jest.fn().mockResolvedValue({ id: "run-existing", status: "CREATED" }),
        create: jest.fn(),
      },
    });

    const result = await createScanRun(baseRequest, store);

    expect(result.scanRunId).toBe("run-existing");
    expect(result.created).toBe(false);
    expect(store.userEmailFilter.create).not.toHaveBeenCalled();
    expect(store.emailScanRun.create).not.toHaveBeenCalled();
  });

  it("passes gmailQuery into emailFilterVersion", async () => {
    const store = makeMockStore();
    await createScanRun(baseRequest, store);

    expect(store.emailFilterVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gmailQuery: "from:bank" }),
      }),
    );
  });

  it("passes fromDate and toDate into emailScanRun", async () => {
    const store = makeMockStore();
    await createScanRun(baseRequest, store);

    expect(store.emailScanRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromDate: new Date("2026-01-01"),
          toDate: new Date("2026-07-01"),
        }),
      }),
    );
  });

  it("sets scanLimit when provided", async () => {
    const store = makeMockStore();
    await createScanRun({ ...baseRequest, scanLimit: 100 }, store);

    expect(store.emailScanRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scanLimit: 100 }),
      }),
    );
  });

  it("omits scanLimit when not provided", async () => {
    const store = makeMockStore();
    await createScanRun(baseRequest, store);

    const callArgs = (store.emailScanRun.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.data.scanLimit).toBeUndefined();
  });
});
