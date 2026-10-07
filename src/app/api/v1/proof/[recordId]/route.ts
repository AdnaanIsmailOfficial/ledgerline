import { z } from "zod";
import { buildInclusionProof } from "@/lib/audit/proof";
import { getDb } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { errorResponse } from "@/lib/errors";
import { parseOrThrow } from "@/lib/validation";

const recordIdSchema = z.string().regex(/^rec_[0-9a-f-]{36}$/, "is not a record id");

export async function GET(_request: Request, ctx: RouteContext<"/api/v1/proof/[recordId]">): Promise<Response> {
  try {
    const { recordId } = await ctx.params;
    const id = parseOrThrow(recordIdSchema, recordId);
    return Response.json(buildInclusionProof(getDb(), id, getEnv().LEDGERLINE_CHECKPOINT_INTERVAL));
  } catch (err) {
    return errorResponse(err);
  }
}
