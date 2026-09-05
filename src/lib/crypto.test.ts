import { describe, it, expect, beforeAll } from "vitest";

// A fixed 32-byte test key (64 hex chars) — not a real secret.
const TEST_KEY = "0".repeat(63) + "1";

beforeAll(() => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

describe("encrypt/decrypt", () => {
  it("round-trips a plaintext token", async () => {
    const { encrypt, decrypt } = await import("./crypto");
    const token = "ya29.a0AfH6SMB_fake_access_token_value";
    const ciphertext = encrypt(token);
    expect(ciphertext).not.toContain(token);
    expect(decrypt(ciphertext)).toBe(token);
  });

  it("produces different ciphertext for the same plaintext (random IV)", async () => {
    const { encrypt } = await import("./crypto");
    const a = encrypt("same-value");
    const b = encrypt("same-value");
    expect(a).not.toBe(b);
  });

  it("rejects tampered ciphertext", async () => {
    const { encrypt, decrypt } = await import("./crypto");
    const ciphertext = encrypt("secret-refresh-token");
    const parts = ciphertext.split(":");
    // Flip a hex character in the encrypted payload to simulate tampering.
    const tampered = [parts[0], parts[1], parts[2]!.replace(/^./, (c) => (c === "0" ? "1" : "0"))].join(":");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws a clear error when the encryption key is missing", async () => {
    const original = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    const { encrypt } = await import("./crypto");
    expect(() => encrypt("x")).toThrow(/OAUTH_TOKEN_ENCRYPTION_KEY/);
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = original;
  });
});
