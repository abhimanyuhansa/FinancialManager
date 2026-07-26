import {
  buildLlmDisabledParseLogs,
  UNPARSED_LLM_DISABLED,
} from "@/lib/legacyIngestion";

describe("static-only deterministic misses", () => {
  it("creates completed review records without recording a body as sent", () => {
    const logs = buildLlmDisabledParseLogs(
      [
        {
          msgId: "gmail-message-1",
          senderDomain: "example-bank.test",
          receivedDate: "2026-07-20",
          body: "Unrecognized transaction alert",
          bodyLengthRaw: 2048,
          bodyWasTruncated: true,
        },
      ],
      { id: "sync-1", userId: "user-1" },
    );

    expect(logs).toEqual([
      expect.objectContaining({
        userId: "user-1",
        syncJobId: "sync-1",
        gmailMsgId: "gmail-message-1",
        senderDomain: "example-bank.test",
        outcome: UNPARSED_LLM_DISABLED,
        resolvedBy: "llm_disabled",
        bodyLengthRaw: 2048,
        bodyLengthSent: 0,
        wasTruncated: true,
        batchSize: 1,
      }),
    ]);
    expect(logs[0].transactionId).toBeUndefined();
    expect(logs[0].errorDetail).toBeUndefined();
  });
});
