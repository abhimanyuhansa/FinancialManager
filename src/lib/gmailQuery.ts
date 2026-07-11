export function buildGmailQuery(syncFromDate: Date): string {
  const afterSeconds = Math.floor(syncFromDate.getTime() / 1000);

  const subjectKeywords = [
    "statement", "transaction", "payment", "invoice", "receipt",
    "order", "purchase", "refund", "debit", "credit", "debited",
    "credited", "charged", "transferred", "OTP", "UPI", "NEFT",
    "IMPS", "RTGS", "EMI", "mandate", "autopay", "subscription",
  ];

  const fromKeywords = [
    "bank", "pay", "card", "wallet", "finance", "money",
    "credit", "noreply", "alerts", "notify", "notification",
  ];

  const subjectClause = `subject:(${subjectKeywords.join(" OR ")})`;
  const fromClause = `from:(${fromKeywords.join(" OR ")})`;

  return [
    `after:${afterSeconds}`,
    `-category:promotions`,
    `-category:forums`,
    `(${subjectClause} OR ${fromClause})`,
  ].join(" ");
}
