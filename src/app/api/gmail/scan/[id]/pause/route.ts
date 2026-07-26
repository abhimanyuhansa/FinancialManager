import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pauseScan } from "@/lib/scan/scanControlService";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const result = await pauseScan(session.user.id, id);
  return result
    ? NextResponse.json(result)
    : NextResponse.json({ error: "Scan not found" }, { status: 404 });
}
