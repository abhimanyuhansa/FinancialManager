import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getScanProgressForUser } from "@/lib/scan/scanProgressService";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const result = await getScanProgressForUser(session.user.id, id);
  if (!result) {
    return NextResponse.json({ error: "Scan not found" }, { status: 404 });
  }

  return NextResponse.json(result);
}
