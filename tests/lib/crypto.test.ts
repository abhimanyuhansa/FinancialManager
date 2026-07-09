import { encrypt, decrypt } from "@/lib/crypto";

describe("crypto", () => {
  beforeAll(() => {
    process.env.STATEMENT_ENCRYPTION_KEY = "a".repeat(64);
  });

  it("encrypt produces a hex string", () => {
    const ciphertext = encrypt("hunter2");
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
    expect(ciphertext.length).toBeGreaterThan(56); // IV(24) + tag(32) + at least 2 hex chars
  });

  it("decrypt round-trips plaintext", () => {
    const original = "my-secret-password-123!";
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it("different encryptions produce different ciphertexts (random IV)", () => {
    const c1 = encrypt("same");
    const c2 = encrypt("same");
    expect(c1).not.toBe(c2);
  });

  it("throws on tampered ciphertext", () => {
    const ciphertext = encrypt("test");
    const tampered = ciphertext.slice(0, -2) + "ff";
    expect(() => decrypt(tampered)).toThrow();
  });
});
