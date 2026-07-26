export type ScanRunStatus =
  | "CREATED"
  | "DISCOVERING"
  | "FETCHING"
  | "RETRY_WAIT"
  | "PAUSED"
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "FAILED"
  | "CANCELLING"
  | "CANCELLED";

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
