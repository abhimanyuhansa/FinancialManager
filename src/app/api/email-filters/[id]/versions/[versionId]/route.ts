import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, versionId } = await context.params;
  const version = await prisma.emailFilterVersion.findFirst({
    where: {
      id: versionId,
      emailFilterId: id,
      emailFilter: { userId: session.user.id },
    },
  });
  if (!version) {
    return NextResponse.json({ error: "Filter version not found" }, { status: 404 });
  }
  return NextResponse.json({ version });
}
