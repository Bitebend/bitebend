import { describe, it, expect } from "vitest";
import { hashPinDigest, generateStaffToken, verifyStaffToken } from "../lib/staffToken";
import { verifyToken } from "../lib/token";

describe("Phase 2: Staff Token and PIN Digest Security", () => {
  it("generates deterministic HMAC-SHA256 PIN digests", () => {
    const pin = "482910";
    const digest1 = hashPinDigest(pin);
    const digest2 = hashPinDigest(pin);
    expect(digest1).toBe(digest2);
    expect(digest1).toHaveLength(64); // 32-byte hex string
  });

  it("produces distinct digests for different PINs", () => {
    const digestA = hashPinDigest("111111");
    const digestB = hashPinDigest("222222");
    expect(digestA).not.toBe(digestB);
  });

  it("trims whitespace when hashing PINs", () => {
    const digest1 = hashPinDigest("123456");
    const digest2 = hashPinDigest("  123456  ");
    expect(digest1).toBe(digest2);
  });

  it("generates and verifies valid staff token", () => {
    const token = generateStaffToken({
      staffId: 42,
      restaurantId: 7,
      role: "waiter",
      tokenVersion: 3,
    });

    const payload = verifyStaffToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.staffId).toBe(42);
    expect(payload?.restaurantId).toBe(7);
    expect(payload?.role).toBe("waiter");
    expect(payload?.tokenVersion).toBe(3);
    expect(payload?.tokenType).toBe("staff");
  });

  it("enforces role isolation: staff token has no userId and cannot authenticate as user", () => {
    const staffToken = generateStaffToken({
      staffId: 99,
      restaurantId: 10,
      role: "chef",
      tokenVersion: 1,
    });

    // When processed by the general/owner verifyToken function
    const userPayload = verifyToken(staffToken);
    // User token parser must not find a valid userId
    expect(userPayload?.userId).toBeUndefined();
  });

  it("rejects tampered staff tokens", () => {
    const token = generateStaffToken({
      staffId: 1,
      restaurantId: 1,
      role: "waiter",
      tokenVersion: 1,
    });

    const parts = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ staffId: 1, restaurantId: 1, role: "chef", tokenVersion: 1, tokenType: "staff" }),
    ).toString("base64url");
    const tamperedToken = `${tamperedPayload}.${parts[1]}`;

    expect(verifyStaffToken(tamperedToken)).toBeNull();
  });

  it("rejects token with invalid tokenType", () => {
    const secret = "test-secret";
    const data = Buffer.from(
      JSON.stringify({ staffId: 1, restaurantId: 1, role: "waiter", tokenType: "customer" }),
    ).toString("base64url");
    const invalidToken = `${data}.invalidsig`;
    expect(verifyStaffToken(invalidToken)).toBeNull();
  });
});
