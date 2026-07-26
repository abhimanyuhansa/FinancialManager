import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  connectedGmailAccountId,
  createFilterWithVersion,
  DEFAULT_INVENTORY_QUERY,
  parseFilterVersionInput,
} from "@/lib/scan/filterService";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const filters = await prisma.userEmailFilter.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    include: { currentVersion: true },
  });
  return NextResponse.json({ filters });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ error: "Invalid filter name" }, { status: 400 });
  }
  let versionInput;
  try {
    versionInput = parseFilterVersionInput({
      gmailQuery: body.gmailQuery ?? DEFAULT_INVENTORY_QUERY,
      includeRules: body.includeRules,
      excludeRules: body.excludeRules,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filter" },
      { status: 400 },
    );
  }
  const gmailAccountId = await connectedGmailAccountId(session.user.id);
  if (!gmailAccountId) {
    return NextResponse.json(
      { error: "No connected Gmail account" },
      { status: 409 },
    );
  }
  const filter = await createFilterWithVersion({
    userId: session.user.id,
    gmailAccountId,
    name,
    ...versionInput,
  });
  return NextResponse.json({ filter }, { status: 201 });
}
