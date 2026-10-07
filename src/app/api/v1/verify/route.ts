import { connection } from "next/server";
import { verifyChain } from "@/lib/audit/verify";
import { getDb } from "@/lib/db/client";
import { errorResponse } from "@/lib/errors";

export async function GET(): Promise<Response> {
  try {
    // The SQLite driver is synchronous, so without this Next.js could prerender
    // the handler at build time and serve one stale result for ever.
    await connection();
    const result = verifyChain(getDb());
    return Response.json({ ...result, verified_at: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
