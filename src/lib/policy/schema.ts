import { z } from "zod";
import { PII_TYPES } from "./pii";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes");

const validRegex = z.string().min(1).refine(
  (source) => {
    try {
      new RegExp(source, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "is not a valid regular expression" },
);

export const policySchema = z
  .object({
    app_id: slug,
    name: z.string().min(1),
    description: z.string().optional(),
    /** Requests for any other model are blocked. */
    allowed_models: z.array(z.string().min(1)).min(1),
    /** Prompts estimated to be larger than this are blocked. */
    max_input_tokens: z.number().int().positive(),
    /** Passed to the provider as the cap on the response length. */
    max_output_tokens: z.number().int().positive(),
    rate_limit: z
      .object({
        requests: z.number().int().positive(),
        window_seconds: z.number().int().positive(),
      })
      .strict(),
    blocked_topics: z
      .array(
        z
          .object({
            id: slug,
            description: z.string().optional(),
            /** Literal phrases, matched case-insensitively on word boundaries. */
            keywords: z.array(z.string().min(1)).default([]),
            /** Regular expressions, matched case-insensitively. */
            patterns: z.array(validRegex).default([]),
          })
          .strict()
          .refine((t) => t.keywords.length + t.patterns.length > 0, "needs at least one keyword or pattern"),
      )
      .default([]),
    /** PII types replaced with placeholders before the prompt leaves the gateway. */
    pii_redaction: z.array(z.enum(PII_TYPES)).default([]),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;
