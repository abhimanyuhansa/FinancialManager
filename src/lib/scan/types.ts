export const SCAN_RUN_STATUSES = [
  "CREATED",
  "DISCOVERING",
  "FETCHING",
  "RETRY_WAIT",
  "PAUSED",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELLING",
  "CANCELLED",
] as const;

export type ScanRunStatus = (typeof SCAN_RUN_STATUSES)[number];

export type ScanStage = "DISCOVERY" | "FETCH";

export type ScanItemStatus =
  | "DISCOVERED"
  | "FETCHING"
  | "FETCHED"
  | "RETRY_WAIT"
  | "PERMANENTLY_FAILED"
  | "CANCELLED";

export type FilterDecision = "PENDING" | "INCLUDED" | "EXCLUDED";

export type ManualClassification =
  | "UNREVIEWED"
  | "FINANCIAL"
  | "NON_FINANCIAL"
  | "UNCERTAIN";

export function isScanRunStatus(value: string): value is ScanRunStatus {
  return (SCAN_RUN_STATUSES as readonly string[]).includes(value);
}

export type CreateScanRequest = {
  userId: string;
  gmailAccountId: string;
  clientRequestId: string;
  filterName: string;
  gmailQuery: string;
  fromDate: Date;
  toDate: Date;
  scanLimit?: number;
};

export type CreateScanResult = {
  scanRunId: string;
  status: ScanRunStatus;
  /** true = newly created; false = existing scan returned (idempotent) */
  created: boolean;
};

export const CLIENT_REQUEST_ID_MAX_LENGTH = 500;
