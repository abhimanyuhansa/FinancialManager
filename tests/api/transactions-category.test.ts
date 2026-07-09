jest.mock("@/lib/auth", () => ({
  auth: jest.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

jest.mock("@/lib/prisma", () => ({
  prisma: {
    transaction: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    merchantRule: {
      upsert: jest.fn(),
    },
  },
}));

import { PATCH } from "@/app/api/transactions/[id]/category/route";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

const mockFindUnique = prisma.transaction.findUnique as jest.MockedFunction<typeof prisma.transaction.findUnique>;
const mockUpdate = prisma.transaction.update as jest.MockedFunction<typeof prisma.transaction.update>;
const mockUpdateMany = prisma.transaction.updateMany as jest.MockedFunction<typeof prisma.transaction.updateMany>;
const mockUpsert = prisma.merchantRule.upsert as jest.MockedFunction<typeof prisma.merchantRule.upsert>;

const mockTransaction = {
  id: "tx-1",
  userId: "user-1",
  merchant: "Swiggy",
  category: "food",
};

function makeRequest(id: string, body: object) {
  return new NextRequest(`http://localhost/api/transactions/${id}/category`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("PATCH /api/transactions/[id]/category", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates single transaction category (scope=single)", async () => {
    mockFindUnique.mockResolvedValue(mockTransaction as never);
    mockUpdate.mockResolvedValue({ ...mockTransaction, category: "transport" } as never);

    const req = makeRequest("tx-1", { category: "transport", scope: "single" });
    const res = await PATCH(req, { params: { id: "tx-1" } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ updatedCount: 1 });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "tx-1" },
      data: { category: "transport" },
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("updates all merchant transactions and upserts MerchantRule (scope=all_merchant)", async () => {
    mockFindUnique.mockResolvedValue(mockTransaction as never);
    mockUpdateMany.mockResolvedValue({ count: 5 });
    mockUpsert.mockResolvedValue({} as never);

    const req = makeRequest("tx-1", { category: "food", scope: "all_merchant" });
    const res = await PATCH(req, { params: { id: "tx-1" } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ updatedCount: 5 });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", merchant: "swiggy" },
      data: { category: "food" },
    });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { userId_merchantName: { userId: "user-1", merchantName: "swiggy" } },
      update: { category: "food" },
      create: { userId: "user-1", merchantName: "swiggy", category: "food" },
    });
  });

  it("returns 404 if transaction not found", async () => {
    mockFindUnique.mockResolvedValue(null);
    const req = makeRequest("missing", { category: "food", scope: "single" });
    const res = await PATCH(req, { params: { id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid scope", async () => {
    mockFindUnique.mockResolvedValue(mockTransaction as never);
    const req = makeRequest("tx-1", { category: "food", scope: "invalid" });
    const res = await PATCH(req, { params: { id: "tx-1" } });
    expect(res.status).toBe(400);
  });
});
