import { z } from "zod";
import { GatewayError } from "@/lib/errors";

export const chatRequestSchema = z
  .object({
    app_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes"),
    user_id: z.string().min(1).max(128),
    model: z.string().min(1).max(100),
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string().min(1).max(100_000),
        }),
      )
      .min(1)
      .max(200)
      .refine((msgs) => msgs.some((m) => m.role === "user"), "must contain at least one user message"),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** Parses with a Zod schema and converts failures into a 400 GatewayError. */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new GatewayError(
      400,
      "invalid_request",
      "Request failed validation",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
