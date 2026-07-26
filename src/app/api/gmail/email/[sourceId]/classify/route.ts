import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  classifyEmail,
  EMAIL_CLASSIFICATIONS,
  type EmailClassification,
} from "@/lib/scan/classificationService";

const CLASSIFICATIONS = new Set<string>(EMAIL_CLASSIFICATIONS);

export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    classification?: unknown;
    reason?: unknown;
  };
  if (
    typeof body.classification !== "string" ||
    !CLASSIFICATIONS.has(body.classification) ||
    (body.reason !== undefined &&
      (typeof body.reason !== "string" || body.reason.length > 500))
  ) {
    return NextResponse.json({ error: "Invalid classification" }, { status: 400 });
  }
  const { sourceId } = await context.params;
  const result = await classifyEmail({
    userId: session.user.id,
    sourceId,
    classification: body.classification as EmailClassification,
    reason: body.reason as string | undefined,
  });
  if (result.outcome === "not_found") {
    return NextResponse.json({ error: "Email source not found" }, { status: 404 });
  }
  if (result.outcome === "conflict") {
    return NextResponse.json({ error: "Classification changed concurrently" }, { status: 409 });
  }
  return NextResponse.json({
    classification: result.classification,
    version: result.version,
    changed: result.outcome === "changed",
  });
}
