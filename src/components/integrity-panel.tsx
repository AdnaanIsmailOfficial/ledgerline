"use client";

import { useState } from "react";
import type { VerifyResult } from "@/lib/audit/verify";
import type { TamperResponse } from "@/lib/api-types";
import { fetchJson } from "@/lib/fetch-json";

const FAILURE_LABEL: Record<string, string> = {
  sequence_gap: "Missing record",
  broken_link: "Broken link",
  hash_mismatch: "Record altered",
  payload_mismatch: "Stored text altered",
  checkpoint_mismatch: "Checkpoint mismatch",
  checkpoint_orphaned: "Log truncated",
};

const short = (hash: string | null) => (hash && hash.length > 20 ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : (hash ?? "none"));

interface Props {
  /** Called with the failing record number (or null) so the table can highlight it. */
  onFlag: (seq: number | null) => void;
  /** Called after the log was changed outside the normal flow, so the table reloads. */
  onLogChanged: () => void;
}

export function IntegrityPanel({ onFlag, onLogChanged }: Props) {
  const [busy, setBusy] = useState<"verify" | "tamper" | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [tampered, setTampered] = useState<TamperResponse["tampered"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The tamper endpoint returns 404 in production, so the button is hidden there too.
  const devMode = process.env.NODE_ENV !== "production";

  async function verify() {
    setBusy("verify");
    setError(null);
    try {
      const res = await fetchJson<VerifyResult>("/api/v1/verify");
      setResult(res);
      onFlag(res.ok ? null : res.failure.seq);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function tamper() {
    setBusy("tamper");
    setError(null);
    try {
      const res = await fetchJson<TamperResponse>("/api/v1/dev/tamper", { method: "POST" });
      setTampered(res.tampered);
      // Any earlier verification result is now out of date.
      setResult(null);
      onFlag(null);
      onLogChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface" aria-labelledby="integrity-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 id="integrity-heading" className="text-sm font-medium">
            Audit log integrity
          </h2>
          <p className="mt-0.5 text-sm text-muted">Recomputes every record hash and checkpoint root from scratch.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {devMode && (
            <button
              onClick={tamper}
              disabled={busy !== null}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-block/60 hover:text-block disabled:opacity-50"
            >
              {busy === "tamper" ? "Editing…" : "Tamper demo"}
            </button>
          )}
          <button
            onClick={verify}
            disabled={busy !== null}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === "verify" ? "Verifying…" : "Verify integrity"}
          </button>
        </div>
      </div>

      <div aria-live="polite">
        {error && (
          <p role="alert" className="border-t border-line px-4 py-3 text-sm text-block">
            {error}
          </p>
        )}

        {tampered && !result && (
          <p className="border-t border-line bg-redact/10 px-4 py-3 text-sm">
            <span className="font-medium text-redact">Record #{tampered.seq} edited directly in SQLite.</span>{" "}
            <span className="text-muted">
              Its {tampered.column} was changed from {tampered.before} to {tampered.after} without going through the
              gateway. Run the integrity check to see it caught.
            </span>
          </p>
        )}

        {result?.ok && (
          <div className="border-t border-line bg-allow/10 px-4 py-3 text-sm">
            <p className="font-medium text-allow">Log intact</p>
            <p className="mt-0.5 text-muted">
              {result.records_checked} records and {result.checkpoints_checked} checkpoints verified. Head hash{" "}
              <code className="font-mono text-xs text-fg">{short(result.head_hash)}</code>
            </p>
          </div>
        )}

        {result && !result.ok && (
          <div className="border-t border-line bg-block/10 px-4 py-3 text-sm">
            <p className="font-medium text-block">
              Tampering detected at record #{result.failure.seq} ({FAILURE_LABEL[result.failure.type] ?? result.failure.type})
            </p>
            <p className="mt-0.5 text-fg">{result.failure.message}</p>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-[auto_1fr]">
              {result.failure.record_id && (
                <>
                  <dt>Record id</dt>
                  <dd className="font-mono break-all text-fg">{result.failure.record_id}</dd>
                </>
              )}
              <dt>Stored value</dt>
              <dd className="font-mono break-all text-fg">{result.failure.expected ?? "none"}</dd>
              <dt>Recomputed</dt>
              <dd className="font-mono break-all text-fg">{result.failure.actual ?? "none"}</dd>
              <dt>Verified before failure</dt>
              <dd className="text-fg">{result.records_checked} records</dd>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
