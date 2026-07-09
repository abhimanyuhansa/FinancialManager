import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { LookbackPeriod, buildScanFromDate } from "@/lib/gmail";

type ApprovedSender = {
  sender: string;
  domain: string;
  sourceRank: number;
};

type ConfirmBody = {
  period: LookbackPeriod;
  approvedSenders: ApprovedSender[];
  rejectedSenders: string[];
};

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await req.json()) as ConfirmBody;
  const { period, approvedSenders, rejectedSenders } = body;

  if (approvedSenders.length > 0) {
    await prisma.$transaction(
      approvedSenders.map((s) =>
        prisma.emailFilter.upsert({
          where: { type_value: { type: "sender_email", value: s.sender } },
          create: {
            type: "sender_email",
            value: s.sender,
            sourceRank: s.sourceRank,
            isActive: true,
            note: "User-approved during onboarding",
          },
          update: { isActive: true, sourceRank: s.sourceRank },
        })
      )
    );
  }

  if (rejectedSenders.length > 0) {
    await prisma.$transaction(
      rejectedSenders.map((sender) =>
        prisma.emailFilter.upsert({
          where: { type_value: { type: "sender_email", value: sender } },
          create: {
            type: "sender_email",
            value: sender,
            sourceRank: 3,
            isActive: false,
            note: "User-rejected during onboarding",
          },
          update: { isActive: false },
        })
      )
    );
  }

  const syncFromDate = buildScanFromDate(period);
  await prisma.user.update({
    where: { id: userId },
    data: { syncFromDate },
  });

  return NextResponse.json({ ok: true, syncFromDate: syncFromDate.toISOString() });
}
