"use client";

import { useEffect, useState } from "react";
import type { RecordRow, RecordsResponse } from "@/lib/api-types";
import { fetchJson } from "@/lib/fetch-json";
import { IntegrityPanel } from "./integrity-panel";

const PAGE_SIZE = 50;
const POLL_MS = 4000;

interface Filters {
  app: string;
  decision: string;
  /** Local calendar dates (YYYY-MM-DD) from the date inputs. */
  from: string;
  to: string;
}
const NO_FILTERS: Filters = { app: "", decision: "", from: "", to: "" };

/** Start of the given local day, plus `addDays`, as a UTC instant for the API. */
function localDayToIso(day: string, addDays = 0): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + addDays).toISOString();
}

function buildQuery(filters: Filters, offset: number): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (filters.app) params.set("app", filters.app);
  if (filters.decision) params.set("decision", filters.decision);
  if (filters.from) params.set("from", localDayToIso(filters.from));
  // The "to" date is inclusive in the UI, so the API bound is the start of the next day.
  if (filters.to) params.set("to", localDayToIso(filters.to, 1));
  return params.toString();
}

const DECISION_STYLE: Record<RecordRow["decision"], string> = {
  ALLOW: "bg-allow/10 text-allow",
  REDACT: "bg-redact/10 text-redact",
  BLOCK: "bg-block/10 text-block",
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const formatCost = (usd: number) => (usd === 0 ? "$0" : `$${usd.toFixed(4)}`);

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

const fieldClass =
  "h-9 rounded-md border border-line bg-surface px-2.5 text-sm text-fg outline-none focus-visible:border-accent";

export function Dashboard() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flaggedSeq, setFlaggedSeq] = useState<number | null>(null);
  // Bumped to force an immediate reload, for example after the tamper demo.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // Set on cleanup so a slow response for old filters can never overwrite newer data.
    let stale = false;
    const load = () => {
      fetchJson<RecordsResponse>(`/api/v1/records?${buildQuery(filters, offset)}`)
        .then((res) => {
          if (stale) return;
          setData(res);
          setError(null);
        })
        .catch((err: Error) => {
          if (!stale) setError(err.message);
        });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [filters, offset, reloadKey]);

  function updateFilter(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
  }

  const filtersActive = Object.values(filters).some(Boolean);
  const summary = data?.summary;
  const total = summary?.total ?? 0;
  const firstShown = total === 0 ? 0 : offset + 1;
  const lastShown = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Requests</h1>
          <p className="mt-1 text-sm text-muted">Every AI request that passed through the gateway, newest first.</p>
        </div>
        <p className="flex items-center gap-2 text-xs text-muted">
          <span className={`h-2 w-2 rounded-full ${error ? "bg-block" : "bg-allow"}`} aria-hidden />
          {error ? "Connection lost" : `Live, refreshing every ${POLL_MS / 1000}s`}
        </p>
      </div>

      <IntegrityPanel onFlag={setFlaggedSeq} onLogChanged={() => setReloadKey((k) => k + 1)} />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={filtersActive ? "Matching requests" : "Requests"} value={summary ? String(summary.total) : "–"} />
        <Stat label="Allowed" value={summary ? String(summary.allow) : "–"} tone="text-allow" />
        <Stat label="Redacted" value={summary ? String(summary.redact) : "–"} tone="text-redact" />
        <Stat label="Blocked" value={summary ? String(summary.block) : "–"} tone="text-block" />
        <Stat label="Estimated cost" value={summary ? `$${summary.cost_usd.toFixed(2)}` : "–"} />
      </dl>

      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <label className="flex flex-col gap-1 text-xs text-muted">
          App
          <select className={fieldClass} value={filters.app} onChange={(e) => updateFilter({ app: e.target.value })}>
            <option value="">All apps</option>
            {data?.apps.map((a) => (
              <option key={a.app_id} value={a.app_id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Decision
          <select
            className={fieldClass}
            value={filters.decision}
            onChange={(e) => updateFilter({ decision: e.target.value })}
          >
            <option value="">All decisions</option>
            <option value="ALLOW">Allow</option>
            <option value="REDACT">Redact</option>
            <option value="BLOCK">Block</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          From
          <input
            type="date"
            className={fieldClass}
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => updateFilter({ from: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          To
          <input
            type="date"
            className={fieldClass}
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => updateFilter({ to: e.target.value })}
          />
        </label>
        {filtersActive && (
          <button
            type="button"
            onClick={() => updateFilter(NO_FILTERS)}
            className="h-9 rounded-md px-2.5 text-sm text-muted hover:text-fg"
          >
            Clear filters
          </button>
        )}
      </form>

      {error && (
        <p role="alert" className="rounded-lg border border-block/40 bg-block/10 px-4 py-3 text-sm text-block">
          Could not load requests: {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[980px] border-collapse text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">#</th>
              <th className="px-3 py-2.5 font-medium">Time</th>
              <th className="px-3 py-2.5 font-medium">App</th>
              <th className="px-3 py-2.5 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">Model</th>
              <th className="px-3 py-2.5 font-medium">Decision</th>
              <th className="px-3 py-2.5 font-medium">Rules fired</th>
              <th className="px-3 py-2.5 text-right font-medium">Latency</th>
              <th className="px-3 py-2.5 text-right font-medium">Tokens in / out</th>
              <th className="px-4 py-2.5 text-right font-medium">Est. cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.records.map((r) => {
              const flagged = r.seq === flaggedSeq;
              return (
                <tr key={r.seq} className={flagged ? "bg-block/10 outline outline-1 -outline-offset-1 outline-block" : "hover:bg-raised/60"}>
                  <td className="px-4 py-2 font-mono text-xs text-muted tabular-nums">
                    {r.seq}
                    {flagged && <span className="ml-2 font-sans font-medium text-block">tampered</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">{timeFormat.format(new Date(r.ts))}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.app_id}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{r.user_id}</td>
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                    {r.model}
                    {r.mock && r.status === "ok" && <span className="ml-1.5 font-sans text-muted">(mock)</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${DECISION_STYLE[r.decision]}`}>
                      {r.decision}
                    </span>
                    {r.status === "provider_error" && <span className="ml-1.5 text-xs text-block">provider error</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.rules_fired.length === 0 ? (
                      <span className="text-muted">–</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {r.rules_fired.map((rule) => (
                          <code key={rule} className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap">
                            {rule}
                          </code>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{r.latency_ms} ms</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                    {r.input_tokens} / {r.output_tokens}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">{formatCost(r.cost_usd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {!data && !error && <p className="px-4 py-8 text-center text-sm text-muted">Loading requests…</p>}
        {data && data.records.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted">
            {filtersActive ? (
              "No requests match these filters."
            ) : (
              <>
                The audit log is empty. Run <code className="font-mono text-fg">npm run seed</code> to load demo traffic.
              </>
            )}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between text-sm text-muted">
        <p className="tabular-nums">
          {total === 0 ? "0 requests" : `${firstShown} to ${lastShown} of ${total}`}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={offset === 0}
            className="rounded-md border border-line px-3 py-1.5 hover:text-fg disabled:opacity-40"
          >
            Newer
          </button>
          <button
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={lastShown >= total}
            className="rounded-md border border-line px-3 py-1.5 hover:text-fg disabled:opacity-40"
          >
            Older
          </button>
        </div>
      </div>
    </div>
  );
}
