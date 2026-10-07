export const PII_TYPES = ["email", "phone", "sa_id", "card"] as const;
export type PiiType = (typeof PII_TYPES)[number];

export const PII_PLACEHOLDER: Record<PiiType, string> = {
  email: "[REDACTED_EMAIL]",
  phone: "[REDACTED_PHONE]",
  sa_id: "[REDACTED_SA_ID]",
  card: "[REDACTED_CARD]",
};

/** Luhn checksum, used by both payment cards and South African ID numbers. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * SA ID layout: YYMMDD SSSS C A Z. We require a real calendar date, a valid
 * citizenship digit (C) and a correct Luhn check digit (Z), which rejects the
 * vast majority of random 13-digit numbers such as order or tracking numbers.
 */
export function isValidSaId(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return false;
  if (!"012".includes(digits[10])) return false;
  return luhnValid(digits);
}

function isValidCard(match: string): boolean {
  const digits = match.replace(/[ -]/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

interface Detector {
  type: PiiType;
  pattern: RegExp;
  validate?: (match: string) => boolean;
}

// Order matters: each detector runs on the output of the previous one, so the
// most specific patterns go first. Phones run before cards because a number
// like 0027 82 123 4567 is 13 digits long and can pass the card Luhn check by
// chance; its dialling prefix is the stronger signal.
// The trailing lookaheads force every numeric match to be the whole digit run,
// so nothing is ever "found" inside a longer sequence of digits.
const DETECTORS: Detector[] = [
  { type: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { type: "sa_id", pattern: /(?<!\d)\d{13}(?!\d)/g, validate: isValidSaId },
  // South African numbers: +27 82 123 4567, 0027821234567, 082 123 4567, 011-555-0100
  { type: "phone", pattern: /(?<![\d+])(?:\+27|0027|0)[ -]?\d{2}[ -]?\d{3}[ -]?\d{4}(?![ -]?\d)/g },
  // Any other number written in international format
  { type: "phone", pattern: /(?<![\d+])\+\d{1,3}(?:[ -]?\d){7,12}(?![ -]?\d)/g },
  {
    type: "card",
    pattern: /(?<!\d[ -]?)\d(?:[ -]?\d){12,18}(?![ -]?\d)/g,
    validate: isValidCard,
  },
];

export interface RedactionResult {
  text: string;
  /** How many values of each type were replaced. Types with no matches are absent. */
  counts: Partial<Record<PiiType, number>>;
}

export function redactPii(text: string, types: readonly PiiType[]): RedactionResult {
  const counts: Partial<Record<PiiType, number>> = {};
  let out = text;
  for (const detector of DETECTORS) {
    if (!types.includes(detector.type)) continue;
    out = out.replace(detector.pattern, (match) => {
      if (detector.validate && !detector.validate(match)) return match;
      counts[detector.type] = (counts[detector.type] ?? 0) + 1;
      return PII_PLACEHOLDER[detector.type];
    });
  }
  return { text: out, counts };
}
