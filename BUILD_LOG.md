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

## Phase 2: Policy engine

**Asked for:** per-app YAML policies covering blocked topics, PII redaction
(emails, phone numbers, SA ID numbers, card numbers), token limits, allowed
models and per-user rate limits, returning ALLOW, REDACT or BLOCK with the rules
that fired. Redaction must happen before the prompt leaves the gateway.

**What was built:** a Zod-validated policy schema, a loader that fails loudly on
a bad policy file, a PII redactor, and `evaluatePolicy`, a pure function with no
database or network access. It evaluates every rule instead of stopping at the
first, so the log shows all the reasons a request was stopped.

**What went wrong:** the first version of the redactor labelled the phone number
`0027 82 123 4567` as a card number. With the spaces removed it is 13 digits
long, which is a legal card length, and it happens to pass the Luhn checksum.
The card detector ran before the phone detector, so it won.

**How it was caught:** a parameterised unit test that runs seven phone formats
through the redactor and asserts the exact placeholder. Six passed and this one
failed with `[REDACTED_CARD]` where `[REDACTED_PHONE]` was expected.

**What changed:** phone detection now runs before card detection, because a
dialling prefix is a stronger signal than a checksum that passes one time in
ten by chance. Reordering created the opposite risk (the start of a spaced card
number being read as a phone number), so the phone patterns were tightened to
match only a complete run of digits, and a regression test was added for that
case too.

**Decision worth knowing:** redaction also runs on blocked requests. Nothing is
sent to the provider when a request is blocked, but the prompt is still stored
in the audit payload, and that stored copy should not contain raw PII either.

**How it was checked:** 44 new tests (55 in total) covering each rule type on
its own, boundary values for the token and rate limits, several rules firing
together, and four kinds of broken policy file. Four `curl` calls confirmed
REDACT, two BLOCK variants and an unknown app against the running server.

**Known limits:** topic matching is keyword and regex based, so a determined
user can rephrase around it. PII detection is tuned for South African formats;
phone numbers written without a leading `0` or `+` are not detected.
