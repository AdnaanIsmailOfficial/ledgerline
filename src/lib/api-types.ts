/** Response shapes shared between the dashboard API routes and the dashboard UI. */

export interface RecordRow {
  seq: number;
  id: string;
  ts: string;
  app_id: string;
  user_id: string;
  model: string;
  provider: string;
  mock: boolean;
  decision: "ALLOW" | "REDACT" | "BLOCK";
  rules_fired: string[];
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  status: "ok" | "blocked" | "provider_error";
}

export interface RecordsResponse {
  records: RecordRow[];
  /** Totals for everything matching the filters, not just the current page. */
  summary: { total: number; allow: number; redact: number; block: number; cost_usd: number };
  page: { limit: number; offset: number };
  apps: { app_id: string; name: string }[];
}

export interface PolicyView {
  app_id: string;
  name: string;
  description: string | null;
  file: string;
  raw: string;
}

export interface TamperResponse {
  tampered: { seq: number; record_id: string; column: string; before: string; after: string };
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
