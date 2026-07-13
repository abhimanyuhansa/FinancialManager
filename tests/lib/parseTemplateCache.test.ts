import { canonicalise, templateHash } from "@/lib/parseTemplateCache";

describe("canonicalise", () => {
  it("lowercases text", () => {
    expect(canonicalise("Hello World")).toBe("hello world");
  });

  it("normalises CRLF to LF", () => {
    expect(canonicalise("line1\r\nline2")).toBe("line1\nline2");
  });

  it("collapses horizontal whitespace", () => {
    expect(canonicalise("a   b\t\tc")).toBe("a b c");
  });

  it("collapses 3+ blank lines to 2", () => {
    expect(canonicalise("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(canonicalise("  hello  ")).toBe("hello");
  });

  it("is deterministic — same input always same output", () => {
    const text = "  Rs. 1,234.56 debited from your account\r\n\r\n\r\n  on 12-07-26  ";
    expect(canonicalise(text)).toBe(canonicalise(text));
  });
});

describe("templateHash", () => {
  it("returns a 64-char hex string", () => {
    const h = templateHash("subject", "body");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same subject+body always produces same hash", () => {
    expect(templateHash("sub", "bod")).toBe(templateHash("sub", "bod"));
  });

  it("different subject → different hash", () => {
    expect(templateHash("sub1", "bod")).not.toBe(templateHash("sub2", "bod"));
  });

  it("different body → different hash", () => {
    expect(templateHash("sub", "bod1")).not.toBe(templateHash("sub", "bod2"));
  });

  it("whitespace normalization: extra spaces produce same hash", () => {
    expect(templateHash("sub", "hello   world")).toBe(templateHash("sub", "hello world"));
  });
});
