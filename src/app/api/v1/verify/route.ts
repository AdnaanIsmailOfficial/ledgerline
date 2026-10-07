import { connection } from "next/server";
import { verifyChain } from "@/lib/audit/verify";
import { getDb } from "@/lib/db/client";
import { errorResponse } from "@/lib/errors";

export async function GET(): Promise<Response> {
  // The SQLite driver is synchronous, so without this Next.js could prerender
  // the handler at build time and serve one stale result for ever. It stays
  // outside the try block: during a build it signals "skip prerendering" by
  // rejecting, and that signal must not be caught and logged as an error.
  await connection();
  try {
    const result = verifyChain(getDb());
    return Response.json({ ...result, verified_at: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
