import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type { LookbackPeriod } from "@/lib/gmail";
import { createScan } from "@/lib/scan/scanDomainService";
import { QStashScheduler } from "@/lib/scan/schedulers/qstash";

const PERIODS = new Set<LookbackPeriod>(["1m", "3m", "6m"]);

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    clientRequestId?: unknown;
    period?: unknown;
  };
  if (
    body.clientRequestId !== undefined &&
    (typeof body.clientRequestId !== "string" ||
      body.clientRequestId.length < 8 ||
      body.clientRequestId.length > 100)
  ) {
    return NextResponse.json({ error: "Invalid clientRequestId" }, { status: 400 });
  }
  if (
    body.period !== undefined &&
    (typeof body.period !== "string" ||
      !PERIODS.has(body.period as LookbackPeriod))
  ) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }

  let scheduler: QStashScheduler;
  try {
    scheduler = new QStashScheduler();
  } catch {
    return NextResponse.json(
      { error: "Background scheduler is not configured" },
      { status: 503 },
    );
  }

  try {
    const result = await createScan(
      {
        userId: session.user.id,
        clientRequestId: body.clientRequestId as string | undefined,
        period: body.period as LookbackPeriod | undefined,
      },
      scheduler,
    );
    return NextResponse.json(result, {
      status: result.schedulingStatus === "SCHEDULED" ? 201 : 202,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "No connected Gmail account") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Unable to create scan" }, { status: 500 });
  }
}
