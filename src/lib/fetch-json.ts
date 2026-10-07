import type { ApiError } from "@/lib/api-types";

/** Fetches JSON and turns the gateway's error envelope into a thrown Error with its message. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new Error("Could not reach the gateway. Is the server running?");
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`The gateway returned an unreadable response (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const message = (data as Partial<ApiError>).error?.message;
    throw new Error(message ?? `Request failed (HTTP ${res.status}).`);
  }
  return data as T;
}
