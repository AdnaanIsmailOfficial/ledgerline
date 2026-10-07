import { errorResponse, GatewayError } from "@/lib/errors";
import { processChat } from "@/lib/gateway";
import { chatRequestSchema, parseOrThrow } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new GatewayError(400, "invalid_json", "Request body must be valid JSON");
    }
    const input = parseOrThrow(chatRequestSchema, body);
    return Response.json(await processChat(input));
  } catch (err) {
    return errorResponse(err);
  }
}
