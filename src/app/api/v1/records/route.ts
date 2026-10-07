import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { connection } from "next/server";
import { z } from "zod";
import type { RecordsResponse } from "@/lib/api-types";
import { getDb } from "@/lib/db/client";
import { auditRecords } from "@/lib/db/schema";
import { errorResponse } from "@/lib/errors";
import { loadAllPolicies } from "@/lib/policy/loader";
import { parseOrThrow } from "@/lib/validation";

const querySchema = z
  .object({
    app: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
    decision: z.enum(["ALLOW", "REDACT", "BLOCK"]).optional(),
    /** Inclusive lower bound, ISO 8601 in UTC. */
    from: z.iso.datetime().optional(),
    /** Exclusive upper bound, ISO 8601 in UTC. */
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  // Outside the try block on purpose; see the note in verify/route.ts.
  await connection();
  try {
    const query = parseOrThrow(querySchema, Object.fromEntries(new URL(request.url).searchParams));
    const db = getDb();

    const filters: SQL[] = [];
    if (query.app) filters.push(eq(auditRecords.appId, query.app));
    if (query.decision) filters.push(eq(auditRecords.decision, query.decision));
    if (query.from) filters.push(gte(auditRecords.ts, query.from));
    if (query.to) filters.push(lt(auditRecords.ts, query.to));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = db
      .select()
      .from(auditRecords)
      .where(where)
      .orderBy(desc(auditRecords.seq))
      .limit(query.limit)
      .offset(query.offset)
      .all();

    const totals = db
      .select({
        total: sql<number>`count(*)`,
        allow: sql<number>`coalesce(sum(${auditRecords.decision} = 'ALLOW'), 0)`,
        redact: sql<number>`coalesce(sum(${auditRecords.decision} = 'REDACT'), 0)`,
        block: sql<number>`coalesce(sum(${auditRecords.decision} = 'BLOCK'), 0)`,
        costMicros: sql<number>`coalesce(sum(${auditRecords.costMicros}), 0)`,
      })
      .from(auditRecords)
      .where(where)
      .get();

    const body: RecordsResponse = {
      records: rows.map((r) => ({
        seq: r.seq,
        id: r.id,
        ts: r.ts,
        app_id: r.appId,
        user_id: r.userId,
        model: r.model,
        provider: r.provider,
        mock: r.mock,
        decision: r.decision,
        rules_fired: JSON.parse(r.rulesFired) as string[],
        latency_ms: r.latencyMs,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cost_usd: r.costMicros / 1_000_000,
        status: r.status,
      })),
      summary: {
        total: totals?.total ?? 0,
        allow: totals?.allow ?? 0,
        redact: totals?.redact ?? 0,
        block: totals?.block ?? 0,
        cost_usd: (totals?.costMicros ?? 0) / 1_000_000,
      },
      page: { limit: query.limit, offset: query.offset },
      apps: loadAllPolicies().map((p) => ({ app_id: p.policy.app_id, name: p.policy.name })),
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
