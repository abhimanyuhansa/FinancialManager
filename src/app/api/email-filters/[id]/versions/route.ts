import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createNextFilterVersion,
  parseFilterVersionInput,
} from "@/lib/scan/filterService";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const owned = await prisma.userEmailFilter.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: "Filter not found" }, { status: 404 });
  }
  const versions = await prisma.emailFilterVersion.findMany({
    where: { emailFilterId: id },
    orderBy: { version: "desc" },
  });
  return NextResponse.json({ versions });
}

export async function POST(request: Request, context: Context) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input;
  try {
    input = parseFilterVersionInput(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filter" },
      { status: 400 },
    );
  }
  const { id } = await context.params;
  try {
    const version = await createNextFilterVersion({
      userId: session.user.id,
      filterId: id,
      ...input,
    });
    if (!version) {
      return NextResponse.json({ error: "Filter not found" }, { status: 404 });
    }
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "filter_version_conflict") {
      return NextResponse.json(
        { error: "Filter changed concurrently" },
        { status: 409 },
      );
    }
    throw error;
  }
}
