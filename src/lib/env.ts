import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  LEDGERLINE_DB_PATH: z.string().min(1).default("./data/ledgerline.db"),
  LEDGERLINE_POLICY_DIR: z.string().min(1).default("./policies"),
  LEDGERLINE_CHECKPOINT_INTERVAL: z.coerce.number().int().min(2).default(50),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

// Read on every call (not cached) so tests and scripts can change process.env.
export function getEnv(): Env {
  const blankAsUnset = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]),
  );
  const parsed = envSchema.safeParse(blankAsUnset);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}
