import { Client } from "@upstash/qstash";
import type {
  SchedulerService,
  ScanWorkerMessage,
  ScheduleOptions,
} from "@/lib/scan/scheduler";

function workerUrl(): string {
  const configured = process.env.APP_URL ?? process.env.AUTH_URL;
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const baseUrl = configured ?? (vercelUrl ? `https://${vercelUrl}` : null);
  if (!baseUrl) throw new Error("Application URL is not configured");
  return new URL("/api/gmail/scan/worker", baseUrl).toString();
}

export class QStashScheduler implements SchedulerService {
  private readonly client: Client;

  constructor(token = process.env.QSTASH_TOKEN) {
    if (!token) throw new Error("QStash token is not configured");
    this.client = new Client({ token });
  }

  async publish(
    message: ScanWorkerMessage,
    options: ScheduleOptions,
  ): Promise<void> {
    const delaySeconds = options.notBefore
      ? Math.max(0, Math.ceil((options.notBefore.getTime() - Date.now()) / 1000))
      : undefined;

    await this.client.publishJSON({
      url: workerUrl(),
      body: message,
      retries: 3,
      deduplicationId: options.deduplicationId,
      ...(delaySeconds ? { delay: delaySeconds } : {}),
    });
  }
}
