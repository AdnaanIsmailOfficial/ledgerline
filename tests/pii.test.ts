import { describe, expect, it } from "vitest";
import { isValidSaId, luhnValid, PII_TYPES, redactPii } from "@/lib/policy/pii";

const ALL = PII_TYPES;
const VALID_SA_ID = "8001015009087";
const VALID_CARD = "4111111111111111";

describe("luhnValid", () => {
  it("accepts known-good numbers and rejects a single changed digit", () => {
    expect(luhnValid(VALID_CARD)).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("41x1")).toBe(false);
  });
});

describe("isValidSaId", () => {
  it("accepts a well-formed ID", () => {
    expect(isValidSaId(VALID_SA_ID)).toBe(true);
  });
  it.each([
    ["wrong check digit", "8001015009088"],
    ["month 13", "8013015009087"],
    ["day 32", "8001325009087"],
    ["too short", "800101500908"],
  ])("rejects %s", (_name, value) => {
    expect(isValidSaId(value)).toBe(false);
  });
});

describe("redactPii", () => {
  it("redacts email addresses", () => {
    const r = redactPii("Mail thandi.m+hr@example.co.za or bob@corp.io today", ALL);
    expect(r.text).toBe("Mail [REDACTED_EMAIL] or [REDACTED_EMAIL] today");
    expect(r.counts).toEqual({ email: 2 });
  });

  it.each([
    "+27 82 123 4567",
    "+27821234567",
    "0027 82 123 4567",
    "082 123 4567",
    "0821234567",
    "011-555-0100",
    "+44 20 7946 0958",
  ])("redacts phone number %s", (phone) => {
    const r = redactPii(`Call me on ${phone} please`, ALL);
    expect(r.text).toBe("Call me on [REDACTED_PHONE] please");
    expect(r.counts).toEqual({ phone: 1 });
  });

  it("redacts a valid SA ID number as an ID, not as a card or phone", () => {
    const r = redactPii(`ID number ${VALID_SA_ID}.`, ALL);
    expect(r.text).toBe("ID number [REDACTED_SA_ID].");
    expect(r.counts).toEqual({ sa_id: 1 });
  });

  it("leaves 13-digit numbers that are not valid IDs alone", () => {
    const r = redactPii("Tracking number 1234567890123 shipped", ALL);
    expect(r.text).toBe("Tracking number 1234567890123 shipped");
    expect(r.counts).toEqual({});
  });

  it.each([VALID_CARD, "4111 1111 1111 1111", "4111-1111-1111-1111", "378282246310005"])(
    "redacts card number %s",
    (card) => {
      const r = redactPii(`Charge ${card} now`, ALL);
      expect(r.text).toBe("Charge [REDACTED_CARD] now");
      expect(r.counts).toEqual({ card: 1 });
    },
  );

  it("does not redact card-length numbers that fail the Luhn check", () => {
    const r = redactPii("Order ref 4111 1111 1111 1112", ALL);
    expect(r.text).toContain("4111 1111 1111 1112");
    expect(r.counts.card).toBeUndefined();
  });

  it("does not find a card inside a longer run of digits", () => {
    const r = redactPii(`ref 99${VALID_CARD}99`, ["card"]);
    expect(r.counts).toEqual({});
  });

  it("does not read the start of a spaced card number as a phone number", () => {
    const r = redactPii("pay with 0821 2345 6789 0123 456", ALL);
    expect(r.counts.phone).toBeUndefined();
  });

  it("handles several types in one message", () => {
    const r = redactPii(`I am ${VALID_SA_ID}, card ${VALID_CARD}, a@b.co, 0821234567`, ALL);
    expect(r.text).toBe("I am [REDACTED_SA_ID], card [REDACTED_CARD], [REDACTED_EMAIL], [REDACTED_PHONE]");
    expect(r.counts).toEqual({ sa_id: 1, card: 1, email: 1, phone: 1 });
  });

  it("only redacts the types the policy enables", () => {
    const r = redactPii(`a@b.co and ${VALID_CARD}`, ["card"]);
    expect(r.text).toBe("a@b.co and [REDACTED_CARD]");
    expect(r.counts).toEqual({ card: 1 });
  });

  it("returns clean text untouched", () => {
    const text = "How many leave days do I have left in 2026?";
    expect(redactPii(text, ALL)).toEqual({ text, counts: {} });
  });
});
