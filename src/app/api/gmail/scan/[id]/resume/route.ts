import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resumeScan } from "@/lib/scan/scanControlService";
import { QStashScheduler } from "@/lib/scan/schedulers/qstash";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let scheduler: QStashScheduler;
  try {
    scheduler = new QStashScheduler();
  } catch {
    return NextResponse.json({ error: "Background scheduler is not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  const result = await resumeScan(session.user.id, id, scheduler);
  return result
    ? NextResponse.json(result)
    : NextResponse.json({ error: "Scan not found" }, { status: 404 });
}
