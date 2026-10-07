import { connection } from "next/server";
import type { PolicyView } from "@/lib/api-types";
import { errorResponse } from "@/lib/errors";
import { loadAllPolicies } from "@/lib/policy/loader";

export async function GET(): Promise<Response> {
  // Policies are read from disk on every request, so this must not be prerendered.
  // Kept outside the try block; see the note in verify/route.ts.
  await connection();
  try {
    const body: PolicyView[] = loadAllPolicies().map((p) => ({
      app_id: p.policy.app_id,
      name: p.policy.name,
      description: p.policy.description ?? null,
      file: p.file,
      raw: p.raw,
    }));
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
