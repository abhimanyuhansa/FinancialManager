import { GET, POST } from "@/app/api/categories/route";

const mockAuth = jest.fn();
jest.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

const mockFindMany = jest.fn();
const mockCreate = jest.fn();
const mockFindUnique = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: {
    category: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

describe("GET /api/categories", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns all categories ordered by isDefault desc, name asc", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user1" } });
    mockFindMany.mockResolvedValue([
      { id: "1", slug: "food", name: "Food", icon: "ForkKnife", isDefault: true },
      { id: "2", slug: "fitness", name: "Fitness", icon: "Barbell", isDefault: false },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categories).toHaveLength(2);
    expect(mockFindMany).toHaveBeenCalledWith({
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, slug: true, name: true, icon: true, isDefault: true },
    });
  });
});

describe("POST /api/categories", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new Request("http://localhost/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Fitness", slug: "fitness", icon: "Barbell" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when name or slug missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user1" } });
    const req = new Request("http://localhost/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Fitness" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("creates category with userId from session", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user1" } });
    mockFindUnique.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: "3", slug: "fitness", name: "Fitness", icon: "Barbell", isDefault: false });
    const req = new Request("http://localhost/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Fitness", slug: "fitness", icon: "Barbell" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith({
      data: { name: "Fitness", slug: "fitness", icon: "Barbell", isDefault: false, userId: "user1" },
      select: { id: true, slug: true, name: true, icon: true, isDefault: true },
    });
  });

  it("returns 409 when slug already exists", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user1" } });
    mockFindUnique.mockResolvedValue({ id: "1", slug: "food" });
    const req = new Request("http://localhost/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Food Again", slug: "food", icon: "ForkKnife" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });
});
