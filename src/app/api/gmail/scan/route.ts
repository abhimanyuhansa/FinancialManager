import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { createScanRun } from "@/lib/scan/scanCreateService";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as Record<string, unknown>;
  const { clientRequestId, filterName, gmailQuery, fromDate, toDate, scanLimit } = body;

  if (
    typeof clientRequestId !== "string" ||
    !clientRequestId ||
    typeof filterName !== "string" ||
    !filterName.trim() ||
    typeof gmailQuery !== "string" ||
    !gmailQuery.trim() ||
    typeof fromDate !== "string" ||
    !fromDate ||
    typeof toDate !== "string" ||
    !toDate
  ) {
    return NextResponse.json(
      { error: "clientRequestId, filterName, gmailQuery, fromDate, toDate are required" },
      { status: 400 },
    );
  }

  const account = await prisma.account.findFirst({
    where: { userId: session.user.id, provider: "google", disconnectedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  if (!account) {
    return NextResponse.json(
      { error: "No connected Google account found" },
      { status: 422 },
    );
  }

  const accessToken = await getGmailToken(session.user.id);
  if (!accessToken) {
    return NextResponse.json(
      { error: "No Gmail token — please sign in again" },
      { status: 422 },
    );
  }

  if (scanLimit !== undefined) {
    if (typeof scanLimit !== "number" || !Number.isInteger(scanLimit) || scanLimit <= 0) {
      return NextResponse.json(
        { error: "scanLimit must be a positive integer" },
        { status: 400 },
      );
    }
  }

  const parsedFrom = new Date(fromDate);
  const parsedTo = new Date(toDate);

  if (isNaN(parsedFrom.getTime()) || isNaN(parsedTo.getTime())) {
    return NextResponse.json(
      { error: "fromDate and toDate must be valid ISO date strings" },
      { status: 400 },
    );
  }

  if (parsedFrom >= parsedTo) {
    return NextResponse.json(
      { error: "fromDate must be before toDate" },
      { status: 400 },
    );
  }

  const result = await createScanRun({
    userId: session.user.id,
    gmailAccountId: account.id,
    clientRequestId,
    filterName,
    gmailQuery,
    fromDate: parsedFrom,
    toDate: parsedTo,
    scanLimit: typeof scanLimit === "number" ? scanLimit : undefined,
  });

  return NextResponse.json(result, { status: result.created ? 201 : 200 });
}

