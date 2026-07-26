import { Receiver } from "@upstash/qstash";
import { NextResponse } from "next/server";
import type { ScanWorkerMessage } from "@/lib/scan/scheduler";
import { QStashScheduler } from "@/lib/scan/schedulers/qstash";
import { processScanWorkerMessage } from "@/lib/scan/worker";

function nonRetryable(error: string) {
  return NextResponse.json(
    { error },
    {
      status: 489,
      headers: { "Upstash-NonRetryable-Error": "true" },
    },
  );
}

function parseMessage(body: string): ScanWorkerMessage | null {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (
      typeof value.scanRunId !== "string" ||
      !value.scanRunId ||
      (value.stage !== "DISCOVERY" && value.stage !== "FETCH") ||
      typeof value.sequence !== "string" ||
      !/^\d+$/.test(value.sequence)
    ) {
      return null;
    }
    return {
      scanRunId: value.scanRunId,
      stage: value.stage,
      sequence: value.sequence,
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  if (!signature) return nonRetryable("Invalid worker signature");

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    return NextResponse.json(
      { error: "Worker verification is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  try {
    const valid = await receiver.verify({
      body,
      signature,
      url: request.url,
    });
    if (!valid) return nonRetryable("Invalid worker signature");
  } catch {
    return nonRetryable("Invalid worker signature");
  }

  const message = parseMessage(body);
  if (!message) return nonRetryable("Invalid worker message");

  let scheduler: QStashScheduler;
  try {
    scheduler = new QStashScheduler();
  } catch {
    return NextResponse.json(
      { error: "Background scheduler is not configured" },
      { status: 503 },
    );
  }

  const result = await processScanWorkerMessage(message, scheduler);
  if (result.outcome === "invalid_sequence") {
    return nonRetryable("Invalid worker sequence");
  }
  return NextResponse.json(result);
}
