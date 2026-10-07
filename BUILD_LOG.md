# Build log

How Ledgerline was built with an AI coding agent (Claude Code), phase by phase.
Each entry records what was asked for, what went wrong, how it was caught and
what changed as a result. Entries were written during the build, not afterwards.

## Phase 0: Plan and scaffold

**Asked for:** a folder structure and data model proposal before any code, with
every decision that has a real tradeoff flagged instead of chosen silently.

**What came back:** a proposal with nine flagged decisions. The ones that shaped
the design most:

- The hash chain covers hashes and metadata only. Prompt and response text live
  in a separate table, so text can be deleted without breaking verification.
- Blocked topics use keyword and regex matching, not an LLM classifier, so
  policy decisions are deterministic and testable.
- A hash chain alone cannot stop someone who rewrites every hash after the
  record they tampered with. That needs external anchoring, and the README says so.

**What went wrong:**

- `create-next-app` installed Next.js 16, not 14. Version 16 ships with Cache
  Components switched on, which changes how `GET` route handlers behave: a
  handler that only does a synchronous SQLite read can be prerendered at build
  time and then serve stale data forever.
- Installing Vitest failed with a peer dependency conflict, because the scaffold
  pinned `@types/node` to version 20 and Vitest 5 needs 22 or newer.

**How it was caught:** the scaffold includes an `AGENTS.md` telling agents to
read the bundled docs in `node_modules/next/dist/docs` before writing code. The
caching guide there names `better-sqlite3` explicitly. The Vitest conflict was a
plain `npm install` failure.

**What changed:** every `GET` handler that reads the database calls
`await connection()` first, so it always runs at request time. `@types/node` was
moved to version 24 to match the installed Node runtime.

## Phase 1: Gateway API

**Asked for:** `POST /api/v1/chat` that forwards to Anthropic or OpenAI through
a provider adapter pattern, with a mock mode when no API key is set.

**What was built:** a `ProviderAdapter` interface with Anthropic, OpenAI and
mock implementations, a one-line-per-provider registry that routes by model
name, Zod validation of the request body, and one error type that every failure
goes through so responses always carry a machine-readable code.

**What went wrong:** nothing failed in this phase, but one default was rejected
on purpose. The Anthropic SDK guidance recommends enabling server-side model
fallbacks, where a refused request is retried on a different model. That is
wrong for an audit gateway: the model written to the log must be the model that
actually answered. Fallbacks are left off.

**How it was checked:** 11 unit tests (validation cases, provider resolution
with and without keys, mock determinism), a clean `tsc --noEmit`, and four
`curl` calls against the running dev server covering a valid request, a
validation failure, malformed JSON and an unknown model.

**Not verified:** the real Anthropic and OpenAI code paths are type-checked
against the official SDKs but have never been run against a live API, because
no API key was available during the build.
