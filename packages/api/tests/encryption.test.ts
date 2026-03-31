import { describe, it, expect } from "vitest";
import { encrypt, decrypt, isEncrypted } from "../src/services/encryption.js";

const TEST_KEY = "ci_sk_test1234567890abcdefghijklmnopq";

describe("encrypt", () => {
  it("produces output with enc:v1: prefix", () => {
    const result = encrypt("hello world", TEST_KEY);
    expect(result.startsWith("enc:v1:")).toBe(true);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const a = encrypt("same text", TEST_KEY);
    const b = encrypt("same text", TEST_KEY);
    expect(a).not.toBe(b);
  });

  it("produces output with correct format: enc:v1:iv:ciphertext:authtag", () => {
    const result = encrypt("test", TEST_KEY);
    const parts = result.split(":");
    // enc:v1:iv:ciphertext:authtag = 5 parts separated by ":"
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe("enc");
    expect(parts[1]).toBe("v1");
    // IV should be 24 hex chars (12 bytes)
    expect(parts[2].length).toBe(24);
  });
});

describe("decrypt", () => {
  it("roundtrips: encrypt then decrypt returns original text", () => {
    const plaintext = "User prefers TypeScript over Python";
    const encrypted = encrypt(plaintext, TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("handles backwards compatibility: returns unencrypted text as-is", () => {
    const plaintext = "This was stored before encryption was added";
    expect(decrypt(plaintext, TEST_KEY)).toBe(plaintext);
  });

  it("handles empty string", () => {
    const encrypted = encrypt("", TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe("");
  });

  it("handles unicode content", () => {
    const unicode = "Привет мир 🌍 日本語テスト";
    const encrypted = encrypt(unicode, TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(unicode);
  });

  it("handles long content (10KB)", () => {
    const longContent = "x".repeat(10000);
    const encrypted = encrypt(longContent, TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(longContent);
  });

  it("throws on wrong API key", () => {
    const encrypted = encrypt("secret data", TEST_KEY);
    const wrongKey = "ci_sk_wrong_key_that_should_fail_here";
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encrypt("secret data", TEST_KEY);
    // Tamper with the ciphertext portion
    const parts = encrypted.split(":");
    parts[3] = parts[3].replace(/[0-9a-f]/, "0"); // change one hex char
    const tampered = parts.join(":");
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });
});

describe("isEncrypted", () => {
  it("returns true for encrypted content", () => {
    const encrypted = encrypt("test", TEST_KEY);
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it("returns false for plaintext", () => {
    expect(isEncrypted("just plain text")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isEncrypted("")).toBe(false);
  });

  it("returns false for partial prefix", () => {
    expect(isEncrypted("enc:v1")).toBe(false);
    expect(isEncrypted("enc:")).toBe(false);
  });
});
