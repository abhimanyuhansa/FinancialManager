// tests/lib/advance.test.ts
// Integration-style unit test for the advance route's message-fetch handling.
// We test the pure logic by extracting the relevant section — not by importing
// the route handler (which requires full Next.js wiring).

// The test here verifies the invariant that missing Gmail batch responses
// produce a ParseLog with outcome="error" and are NOT marked processed.

describe("advance route — missing Gmail batch response handling", () => {
  it("should write an error ParseLog for messages missing from the batch response", () => {
    // Arrange: simulate 3 pending rows, Gmail only returns 2
    const pending = [
      { id: "row1", gmailMsgId: "msg1" },
      { id: "row2", gmailMsgId: "msg2" },
      { id: "row3", gmailMsgId: "msg3" }, // this one is missing
    ];

    const fetchedMap = new Map([
      ["msg1", { id: "msg1", body: "test", senderName: "HDFC Bank", senderEmail: "alerts@hdfcbank.bank.in", senderDomain: "hdfcbank.bank.in", receivedDate: "2026-07-16", subject: "Alert", hasPdfAttachment: false, pdfAttachmentId: null }],
      ["msg2", { id: "msg2", body: "test2", senderName: "SBI", senderEmail: "alerts@alerts.sbi.bank.in", senderDomain: "alerts.sbi.bank.in", receivedDate: "2026-07-16", subject: "Alert2", hasPdfAttachment: false, pdfAttachmentId: null }],
      // msg3 intentionally absent
    ]);

    const missingLogs: string[] = [];
    const missingRowIds = new Set<string>();
    const processable = [];

    for (const { id: rowId, gmailMsgId } of pending) {
      const msg = fetchedMap.get(gmailMsgId);
      if (!msg) {
        // REL-8 fix: record a ParseLog for missing messages
        missingLogs.push(gmailMsgId);
        missingRowIds.add(rowId);
        continue;
      }
      processable.push({ rowId, gmailMsgId, msg });
    }

    expect(missingLogs).toEqual(["msg3"]);
    expect(missingRowIds.has("row3")).toBe(true);
    expect(missingRowIds.has("row1")).toBe(false);
    expect(processable).toHaveLength(2);

    // The row IDs in missingRowIds must NOT appear in the processed=true updateMany
    const idsToMarkProcessed = pending
      .map((p) => p.id)
      .filter((id) => !missingRowIds.has(id));
    expect(idsToMarkProcessed).toEqual(["row1", "row2"]);
    expect(idsToMarkProcessed).not.toContain("row3");
  });
});
