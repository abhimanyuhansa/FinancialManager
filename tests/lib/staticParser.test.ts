import { parseEmailStatic, type EmailInput } from "@/lib/staticParser";

function email(overrides: Partial<EmailInput> = {}): EmailInput {
  return {
    body: "Some email body",
    senderName: "Test Sender",
    senderDomain: "example.com",
    senderEmail: "noreply@example.com",
    subject: "Test Subject",
    receivedDate: "2026-07-16",
    ...overrides,
  };
}

describe("staticParser — known senders with unsupported formats", () => {
  it("hdfcbank.net with unrecognized body returns insufficient_data, not not_transaction", () => {
    const result = parseEmailStatic(email({
      senderDomain: "hdfcbank.net",
      body: "Dear Customer, your HDFC Bank account statement is ready.",
      subject: "Account Statement",
    }));
    expect(result.outcome).toBe("insufficient_data");
  });

  it("airtel.com with unrecognized subject/body returns insufficient_data", () => {
    const result = parseEmailStatic(email({
      senderDomain: "airtel.com",
      body: "Your Airtel service appointment is confirmed.",
      subject: "Service Confirmation",
    }));
    expect(result.outcome).toBe("insufficient_data");
  });

  it("jio.com with unrecognized subject/body returns insufficient_data", () => {
    const result = parseEmailStatic(email({
      senderDomain: "jio.com",
      body: "Your Jio order has been shipped.",
      subject: "Order Shipped",
    }));
    expect(result.outcome).toBe("insufficient_data");
  });

  it("cred.club with unrecognized subject returns insufficient_data", () => {
    const result = parseEmailStatic(email({
      senderDomain: "cred.club",
      body: "Your CRED coins expire soon.",
      subject: "CRED rewards update",
    }));
    expect(result.outcome).toBe("insufficient_data");
  });

  it("uber.com with unrecognized subject returns insufficient_data", () => {
    const result = parseEmailStatic(email({
      senderDomain: "uber.com",
      body: "Your Uber account was accessed from a new device.",
      subject: "New device login",
    }));
    expect(result.outcome).toBe("insufficient_data");
  });

  it("mahadiscom.in with unrecognized subject returns insufficient_data", () => {
    const result = parseEmailStatic(email({
      senderDomain: "mahadiscom.in",
      body: "Your electricity meter reading has been recorded.",
      subject: "Meter Reading Notice",
    }));
    expect(result.outcome).toBe("insufficient_data");
  });

  it("zomato.com with no amount in body returns not_transaction (truly non-financial)", () => {
    const result = parseEmailStatic(email({
      senderDomain: "zomato.com",
      body: "Your Zomato Pro membership renews next month.",
      subject: "Zomato Pro update",
    }));
    // No amount pattern found — NONE is correct here (Zomato parser returns NONE not INSUF)
    expect(result.outcome).toBe("not_transaction");
  });

  it("swiggy.in order confirmation subject returns parsed/insufficient_data (never not_transaction)", () => {
    const result = parseEmailStatic(email({
      senderDomain: "swiggy.in",
      body: "Your order was delivered.",
      subject: "Your order was successfully delivered",
    }));
    // Subject matches financial pattern — should try to parse. If amount missing → insufficient_data.
    expect(result.outcome).not.toBe("not_transaction");
  });

  it("known SKIP_DOMAINS still return not_transaction", () => {
    const result = parseEmailStatic(email({ senderDomain: "linkedin.com" }));
    expect(result.outcome).toBe("not_transaction");
  });

  it("hdfcbank.bank.in with valid UPI debit returns parsed", () => {
    const result = parseEmailStatic(email({
      senderDomain: "hdfcbank.bank.in",
      body: "Rs. 500 is debited from your account towards VPA user@upi (Merchant Name) on 15-07-26 12:30:00",
      subject: "HDFC Bank UPI Alert",
    }));
    expect(result.outcome).toBe("parsed");
    expect(result.transactions[0].amount).toBe(500);
  });

  it("unknown domain returns insufficient_data (not not_transaction)", () => {
    const result = parseEmailStatic(email({ senderDomain: "newbank.co.in" }));
    expect(result.outcome).toBe("insufficient_data");
  });
});
