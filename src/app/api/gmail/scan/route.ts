import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGmailToken } from "@/lib/gmail";
import { createScanRun } from "@/lib/scan/scanCreateService";
import type { CreateScanResult } from "@/lib/scan/types";
import { CLIENT_REQUEST_ID_MAX_LENGTH } from "@/lib/scan/types";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
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

  if (filterName.length > 255) {
    return NextResponse.json(
      { error: "filterName must be 255 characters or fewer" },
      { status: 400 },
    );
  }

  if (clientRequestId.length > CLIENT_REQUEST_ID_MAX_LENGTH) {
    return NextResponse.json(
      { error: `clientRequestId must be ${CLIENT_REQUEST_ID_MAX_LENGTH} characters or fewer` },
      { status: 400 },
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

  const maxToDate = new Date();
  maxToDate.setFullYear(maxToDate.getFullYear() + 10);
  if (parsedTo > maxToDate) {
    return NextResponse.json(
      { error: "toDate must be within 10 years from today" },
      { status: 400 },
    );
  }

  let result: CreateScanResult;
  try {
    result = await createScanRun({
      userId: session.user.id,
      gmailAccountId: account.id,
      clientRequestId,
      filterName,
      gmailQuery,
      fromDate: parsedFrom,
      toDate: parsedTo,
      scanLimit: typeof scanLimit === "number" ? scanLimit : undefined,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid persisted scan status:")) {
      return NextResponse.json(
        { error: "Scan is in an unrecognised state; please contact support" },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json(result, { status: result.created ? 201 : 200 });
}

