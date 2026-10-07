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

## Phase 3: Verifiable audit log

**Asked for:** every request stored in SQLite as a hash-chained record holding
hashes of the prompt and response, a Merkle checkpoint every 50 records, a
verify endpoint that names the exact record where tampering is found, and an
endpoint returning a Merkle inclusion proof for one record.

**What was built:**

- `appendRecord` reads the current head and inserts the next record inside one
  `IMMEDIATE` SQLite transaction, so concurrent requests cannot fork the chain.
  A checkpoint is written in the same transaction as the record that completes
  its batch.
- `hashRecord` lists every hashed field by name and includes a version number,
  so adding a column later cannot silently change old hashes.
- `verifyChain` recomputes everything from row contents and reports one of six
  failure types with the record number, the expected value and the actual value.
- Merkle trees follow RFC 6962: separate prefixes for leaves and internal
  nodes, and no duplicated last node.

**What went wrong:**

1. Writing the tamper tests exposed a real limit of the design, not a bug in the
   code. An attacker who edits a record in the newest, not yet checkpointed part
   of the log and then recomputes every hash after it leaves a log that verifies
   cleanly. The same is true under a checkpoint if they also rewrite the
   checkpoint root. A database cannot defend itself against someone who can
   rewrite all of it.
2. Phase 1 returned a plain 400 for a model no provider serves, which meant the
   request left no trace in the log. For an audit product that is the wrong
   call: a request for a model the app is not allowed to use is a policy event.
3. One new test was itself wrong. It read the expected record id before the
   call that creates the record, so it compared against `undefined` and failed.

**How it was caught:** items 1 and 3 by the test suite. Item 1 only showed up
because the tests include a helper that plays a careful attacker, recomputing
the chain after an edit, instead of only testing clumsy single-field edits.
Item 2 was caught on review while wiring the audit log into the gateway.

**What changed:**

- The limit in item 1 is now pinned down by two tests that assert the log does
  verify after a full rewrite, so the behaviour is documented and cannot change
  unnoticed. The README states it plainly. Anchoring checkpoint roots somewhere
  the attacker cannot write (the stretch goal) is the real fix.
- Unknown models are now blocked by the `model_not_allowed` rule and logged
  like any other blocked request.
- The broken test was rewritten to capture the error first and read the record
  id afterwards.

**Addition beyond the brief:** verification also checks that stored prompt and
response text still hashes to the values in the record, and that no checkpoint
covers records that have gone missing. Both fell out of the design for free and
close obvious gaps (edited text, a truncated log).

**How it was checked:** 58 new tests (113 in total). The tamper tests edit 11
different columns one at a time, delete a record, forge a single hash, rewrite
the whole chain, truncate the log, edit a checkpoint and edit payload text,
asserting the failure type and record number each time. Merkle proofs are
checked for every leaf in every tree size from 1 to 33. One test confirms the
raw email and ID number from a prompt appear nowhere in the database.

**Not verified:** the concurrency test fires 25 requests at once, but Node runs
them on one thread with a synchronous database driver, so it does not prove
safety across several processes writing to the same file. The transaction mode
is chosen to make that safe; it has not been load tested.

## Phase 4: Seed script

**Asked for:** about 200 realistic requests across three fake apps (HR
assistant, customer support bot, internal code helper) with a mix of ALLOW,
REDACT and BLOCK.

**What was built:** a script that sends 200 requests through the real gateway
pipeline with a canned provider, instead of inserting rows directly. The seeded
log is therefore exactly what live traffic would produce, hash chain and
checkpoints included, and the script verifies the log before it exits. A seeded
random generator makes every run produce the same mix: 132 allowed, 45 redacted
and 23 blocked, including one customer who trips the rate limit.

**What went wrong:** the first plan was to reset the database by deleting the
file. On Windows that fails while the dev server has the file open.

**How it was caught:** before running it, by thinking through the quickstart
order (`seed` then `dev`, then `seed` again after the tamper demo).

**What changed:** the script clears the three tables inside one transaction
instead, which works whether or not the server is running.

## Phase 5: Dashboard

**Asked for:** a live request table with filters by app, decision and date, a
"Verify integrity" button, a dev-only "Tamper demo" button and a policy viewer.

**What was built:** a client-rendered dashboard that polls every four seconds,
three small API routes behind it, and a dark-first theme that follows the
system setting.

**What went wrong:**

1. The first version of the table loaded data by calling an async function from
   inside a React effect. The lint rule `react-hooks/set-state-in-effect`
   rejected it.
2. `next build` printed "unhandled error" lines for three API routes. The
   handlers called `await connection()` inside their `try` block. During a
   build, Next.js rejects that call on purpose to say "do not prerender this
   route", and the `catch` block was treating that signal as a real failure and
   logging it.
3. In the browser, the tamper button appeared stuck on "Editing…" and the
   following click on "Verify integrity" did nothing.

**How it was caught:** item 1 by `eslint`, item 2 by running a production build
instead of trusting the dev server, item 3 by driving the real page in a
browser and reading the panel text after each click.

**What changed:**

- The effect now owns the fetch and a `stale` flag set on cleanup, which also
  fixes a race the first version had: a slow response for old filters could
  overwrite newer data.
- `connection()` moved above the `try` block in all three routes, with a
  comment explaining why it must stay there. The build is now clean.
- Item 3 turned out not to be a bug. The route was being compiled for the first
  time by the dev server, which took a few seconds, and the buttons are
  correctly disabled while a request is in flight. Checked by waiting and
  re-reading the panel, then confirming the request returned 200.

**How it was checked:** in a real browser: verify passes on a clean log, the
tamper demo edits record 187, verify then fails naming record 187 with the
stored and recomputed hashes, the row is highlighted, filters return the same
counts as a direct SQL query (4 blocked HR requests), and the policy viewer
shows the YAML on disk. The screenshots in the README are from that run.

**Not checked:** screen readers and keyboard-only use were not tested beyond
using semantic elements and labels.

## Phase 6: Docker and documentation

**Asked for:** a Dockerfile, a README and this log.

**What was built:** a two-stage Dockerfile, and a README covering the problem,
quickstart, architecture, how verification works in plain language, tradeoffs
and next steps.

**Not verified:** the Dockerfile has never been built. Docker is not installed
on the development machine. The file is deliberately simple (it copies the
whole built app instead of a trimmed bundle) to reduce the chance that it is
wrong, and the README says it is untested.

**Not built:** the optional stretch goal, anchoring checkpoint roots to a public
testnet. It needs a funded testnet wallet. The database column for the
transaction hash exists, and the README explains why anchoring matters.

## Summary of what the tests and checks caught

| Caught by | What |
|---|---|
| Unit test | A phone number classified as a card number |
| Unit test | A new test that compared against `undefined` |
| Adversarial test | The limit of what a self-contained log can prove |
| Lint | State updates fired from inside a React effect |
| Production build | A framework signal swallowed by a `catch` block |
| Bundled framework docs | SQLite reads that would have been prerendered and gone stale |
| Review | Requests for unknown models leaving no audit trail |
| Dependency install | A Node types version conflict |

## My own notes

<!-- Adnaan: space for your own reflections before you submit. For example:
     which of the flagged tradeoffs you would decide differently, and what
     you would ask the agent to do differently next time. -->
