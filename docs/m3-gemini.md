# M3: Gemini for gap intake and "why this worker"

Gemini reads and words; code decides. Spend and abuse guardrails are listed below.

## What Gemini does, and does not do

| Does                                                                                                                             | Does not                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Reads the manager's free-text note into fields (role, date, start, end, venue, base rate, max premium %, missing[], confidence). | Decide eligibility, ranking, rates, holds, captures or payouts. Code does all of that. |
| Words one short reason per top candidate on the gap detail ("why this worker").                                                  | Change the order of workers or who is eligible.                                        |
|                                                                                                                                  | Write offer copy (out of scope; templates stay).                                       |

Model: `gemini-3.5-flash-lite` only (`ALLOWED_LLM_MODEL`, env refuses anything else). Thinking is minimal, output is capped by
`LLM_MAX_OUTPUT_TOKENS`, `store: false`. All calls go through `src/llm/gemini.ts`; no other file imports the SDK.

## Gap intake: `POST /api/manager/gaps/parse`

1. The rules parser always runs first (cheap, deterministic). It is the fallback and supplies the called-out name.
2. Gemini is asked for a structured answer (`src/llm/intake.ts`). The note is passed in a delimited data block.
3. The answer is re-validated by code (`validateIntake`). Anything that fails returns a reason and the **rules result is used**:
   - role must be a known role; date must be today to +14 days; start and end must both be present, end after start (overnight allowed), at most 16 hours, not already over an hour past;
   - a **rate** must be $5 to $100 per hour **and appear as a figure in the note**; a **premium** must be 0 to 50 and appear in the note (or "no surge" for 0);
   - confidence must be at least 0.5; an answer with nothing read is refused.
4. Independently of the source, a rate or premium read from text that is outside the allowed range is **ignored** (role default or configured default applies). This also closes the rules parser's old `$500` hole.
5. The response has `source` (`llm` or `rules`) and `fallback_reason` (null when Gemini answered). Money (worker pay at cap, fee, hold) is computed by existing code from the validated fields. The manager still confirms every field before any money action; the confirm flow is unchanged.

`fallback_reason` values: `disabled`, `daily_cap`, `user_cap`, `timeout`, `provider_error`, `invalid_output`, `invalid_values`, `low_confidence`, `nothing_read`.

## Why this worker: `GET /api/manager/gaps/[id]` -> `best_matches`

- Top 5 from the existing ranking while the gap is OPEN, OFFERING or UNFILLED. Order and eligibility are the ranking's.
- Input to Gemini per candidate: a reference (`c1`..), rank, shift role, role skills, a **distance band**, number of shifts at this venue, a **reliability tier** and the five normalised score parts. **No names, ids, emails, payout emails or exact distances.**
- Output is schema-validated and each reason must be short and free of money, contact details, links and instruction words, else the **template** is used: `Line cook, 2.4 mi away, 14 shifts here`.
- **Never blocks the page.** The endpoint returns the cached reason or the template at once; misses are filled by one batched background call. Cache key: slot + worker + score version (weights, rank, role, distance band, shifts here, reliability tier, rounded scores). The cache is in memory (one web instance); a restart costs one call per gap. A failed call is not retried for 60 seconds, so the 3 second poll cannot hammer the API.

## Caps and kill switch

| Control                   | Where                                   | Value                                                                                                                                                                                            |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM_ENABLED`             | env, checked on every call              | `false` = no call, rules/template only                                                                                                                                                           |
| Timeout                   | `LLM_TIMEOUT_MS` in `src/llm/gemini.ts` | 5000 ms, the HTTP request is aborted; never retried                                                                                                                                              |
| `LLM_MAX_OUTPUT_TOKENS`   | env                                     | 1024 default                                                                                                                                                                                     |
| `LLM_DAILY_CALL_CAP`      | env, app-wide, from `llm_usage`         | 500 default                                                                                                                                                                                      |
| `LLM_PER_USER_HOURLY_CAP` | env, per manager, from `llm_usage`      | **60 default** (was 20). One parse is 1 call (2 with the single transient retry); one gap detail is 1 batched call per ranking change. 60 covers about 25 parses and 15 detail loads in an hour. |
| Retry                     | at most one, transient errors only      | each attempt counts against the caps                                                                                                                                                             |

If your own `.env` sets `LLM_PER_USER_HOURLY_CAP` it overrides the default; set it to 60 or more for a demo session.
Every call writes or increments an `llm_usage` row (calls, input and output tokens). If the caps cannot be read, no call is made.

## Logging

One line per call: component, ok, reason, latency, token counts (`llm_call`), and one line per parse: source, reason, latency (`gap_parse`).
**Never** the note, the prompt, the model output, names or keys. Tests assert this.

## Fallback paths and the test that proves each

| Situation                            | Result                                                                                                                                  | Test                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `LLM_ENABLED=false`, or no key       | rules parser, `source: rules`, reason `disabled`, **zero fetch calls**                                                                  | `test/gemini-m3.db.test.ts` "LLM disabled"                                                                          |
| Invalid JSON or schema failure       | rules, `invalid_output`                                                                                                                 | `test/gemini-m3.db.test.ts` "invalid JSON"; `src/llm/m3.test.ts` "invalid JSON, wrong shape"                        |
| Provider error                       | rules, `provider_error`                                                                                                                 | `test/gemini-m3.db.test.ts` "a provider error falls back"                                                           |
| Timeout at 5 s                       | rules, `timeout`, request aborted, no retry                                                                                             | `src/llm/m3.test.ts` "the limit is 5 seconds"; `test/gemini-m3.db.test.ts` (same test, 60 ms limit)                 |
| Daily cap / per-user hourly cap      | no call, rules, `daily_cap` / `user_cap`, usage rows written                                                                            | `test/gemini-m3.db.test.ts` "daily cap and per-user hourly cap"                                                     |
| Prompt injection in the note         | no rate, premium or money field changes                                                                                                 | `src/llm/m3.test.ts` "prompt injection"; `test/gemini-m3.db.test.ts` "prompt injection ... changes no rate"         |
| Values break domain rules            | rules, `invalid_values`                                                                                                                 | `src/llm/m3.test.ts` "values that break the domain rules", "must be in range AND actually written"                  |
| Why-this-worker: repeat polls        | one call, then cached                                                                                                                   | `src/llm/m3.test.ts` "caches per (slot, worker, score version)"; `test/gemini-m3.db.test.ts` (6 polls, 1 call)      |
| Why-this-worker: Gemini off          | template                                                                                                                                | `src/llm/m3.test.ts` "LLM off"; `test/gemini-m3.db.test.ts` "Gemini off shows the deterministic template"           |
| Why-this-worker: invalid explanation | template                                                                                                                                | `src/llm/m3.test.ts` "schema-invalid or unusable explanation"                                                       |
| Gemini never gets contact details    | request bodies contain no worker or manager email, payout email, id, name                                                               | `src/llm/m3.test.ts` "never receives names..."; `test/gemini-m3.db.test.ts` "never receives worker contact details" |
| Demo phrase on the rules path        | parses to line cook, 07:00 to 15:00, tomorrow                                                                                           | `test/gemini-m3.db.test.ts` "LLM disabled" (and `test/demo-headline-gap.test.ts`)                                   |
| SDK isolation                        | only `src/llm/gemini.ts` imports `@google/genai`; the key is read only in env and the llm runtime; no client file touches the llm layer | `test/guards.test.ts` "Gemini isolation"                                                                            |
| Logging carries no content           | event keys are fixed; no input or output                                                                                                | `src/llm/m3.test.ts` "logs only component, outcome..."                                                              |

## Live check (local, synthetic data)

`npx tsx scripts/live-gemini-m3.ts` runs one real intake call with the demo phrase and one real "why this worker" call
(made-up facts), with an in-memory usage store. It prints source, latency, tokens and whether the fields matched. It
never prints the key, the prompt or the raw output.

Result of the run on the day it was built (synthetic data, `gemini-3.5-flash-lite`): intake `source=llm`, 2079 ms,
302 input / 112 output tokens (thinking included), all expected fields matched, no rate or premium invented;
"why this worker" 2 reasons accepted, 2125 ms, 307 input / 99 output tokens. About $0.0004 for the pair.
