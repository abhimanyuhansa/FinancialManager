// src/app/api/vpa/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUnresolvedVpas, labelVpaByUser } from "@/lib/vpaLookup";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const vpas = await getUnresolvedVpas(session.user.id);
  return NextResponse.json({ vpas });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    vpa: string;
    merchantName: string;
    category: string;
    subCategory?: string;
  };

  const { vpa, merchantName, category, subCategory } = body;

  if (!vpa || !merchantName || !category) {
    return NextResponse.json({ error: "vpa, merchantName, category required" }, { status: 400 });
  }

  const result = await labelVpaByUser(
    session.user.id, vpa, merchantName, category, subCategory ?? null
  );

  return NextResponse.json({ ok: true, updatedTransactions: result.updatedTransactions });
}
