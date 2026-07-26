export type ScanWorkerStage = "DISCOVERY" | "FETCH";

export type ScanWorkerMessage = {
  scanRunId: string;
  stage: ScanWorkerStage;
  sequence: string;
};

export type ScheduleOptions = {
  deduplicationId: string;
  notBefore?: Date | null;
};

export interface SchedulerService {
  publish(message: ScanWorkerMessage, options: ScheduleOptions): Promise<void>;
}

export class SchedulerUnavailableError extends Error {
  constructor() {
    super("Background scheduler is not configured");
    this.name = "SchedulerUnavailableError";
  }
}

export function workerDeduplicationId(message: ScanWorkerMessage): string {
  return `${message.scanRunId}:${message.stage}:${message.sequence}`;
}
