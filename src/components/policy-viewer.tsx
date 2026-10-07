"use client";

import { useEffect, useState } from "react";
import type { PolicyView } from "@/lib/api-types";
import { fetchJson } from "@/lib/fetch-json";

export function PolicyViewer() {
  const [policies, setPolicies] = useState<PolicyView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<PolicyView[]>("/api/v1/policies")
      .then((data) => {
        setPolicies(data);
        setSelected((current) => current ?? data[0]?.app_id ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-block/40 bg-block/10 px-4 py-3 text-sm text-block">
        Could not load policies: {error}
      </p>
    );
  }
  if (!policies) return <p className="text-sm text-muted">Loading policies…</p>;
  if (policies.length === 0) return <p className="text-sm text-muted">No policy files found in the policy folder.</p>;

  const active = policies.find((p) => p.app_id === selected) ?? policies[0];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Policies</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The active policy for each app, exactly as written on disk. Policies are read on every request, so an edit to
          a file takes effect immediately.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Apps">
        {policies.map((p) => {
          const isActive = p.app_id === active.app_id;
          return (
            <button
              key={p.app_id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setSelected(p.app_id)}
              className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                isActive ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:text-fg"
              }`}
            >
              {p.name}
            </button>
          );
        })}
      </div>

      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-medium">{active.name}</h2>
            {active.description && <p className="mt-0.5 text-sm text-muted">{active.description}</p>}
          </div>
          <code className="font-mono text-xs text-muted">policies/{active.file}</code>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-fg">{active.raw}</pre>
      </section>
    </div>
  );
}
