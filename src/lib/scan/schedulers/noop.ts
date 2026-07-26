import type {
  SchedulerService,
  ScanWorkerMessage,
  ScheduleOptions,
} from "@/lib/scan/scheduler";

export class NoopScheduler implements SchedulerService {
  readonly published: Array<{
    message: ScanWorkerMessage;
    options: ScheduleOptions;
  }> = [];

  async publish(
    message: ScanWorkerMessage,
    options: ScheduleOptions,
  ): Promise<void> {
    this.published.push({ message, options });
  }
}
