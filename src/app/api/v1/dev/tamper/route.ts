import type { TamperResponse } from "@/lib/api-types";
import { getDb } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { errorResponse, GatewayError } from "@/lib/errors";

interface Target {
  seq: number;
  id: string;
  decision: string;
}

/**
 * Development-only demo. Edits one audit record with raw SQL, bypassing the
 * gateway entirely, the way someone with access to the database file would.
 * It deliberately does not fix up any hashes, so the next integrity check fails.
 *
 * Run `npm run seed` to get a clean log back.
 */
export async function POST(): Promise<Response> {
  try {
    if (getEnv().NODE_ENV === "production") {
      throw new GatewayError(404, "not_found", "Not found");
    }
    const sqlite = getDb().$client;

    // Prefer the most realistic cover-up: a blocked request rewritten to look allowed.
    const target =
      (sqlite.prepare("SELECT seq, id, decision FROM audit_records WHERE decision = 'BLOCK' ORDER BY seq DESC LIMIT 1").get() as Target | undefined) ??
      (sqlite.prepare("SELECT seq, id, decision FROM audit_records ORDER BY seq DESC LIMIT 1").get() as Target | undefined);
    if (!target) {
      throw new GatewayError(409, "log_empty", "There are no audit records to tamper with. Run `npm run seed` first.");
    }

    const after = target.decision === "BLOCK" ? "ALLOW" : "BLOCK";
    sqlite.prepare("UPDATE audit_records SET decision = ? WHERE seq = ?").run(after, target.seq);

    const body: TamperResponse = {
      tampered: { seq: target.seq, record_id: target.id, column: "decision", before: target.decision, after },
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
