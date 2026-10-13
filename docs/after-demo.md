# Planned after the demo

Decisions recorded so the demo scope stays small. None of these is built yet.

- **Gemini gap parser.** The manager's "tell us what happened" note is read by the rules parser
  ([`src/domain/gap-parser.ts`](../src/domain/gap-parser.ts)) only. The Gemini client and guardrails exist from M0
  (`src/llm`), but the parse endpoint does not call them: **no Gemini call is made anywhere in the running app.** Wiring
  `gemini-3.5-flash-lite` into intake (with the spend guardrails of PLAN 9.3 and the rules parser as fallback) is planned
  after the demo.
- **Widen the cap.** Raising the maximum premium needs an extra PayPal hold approved by the manager. The control is shown
  disabled with the label "Coming soon" on the gap page and has no dialog and no API call until it is built.
- **WhatsApp (option B).** Only per-worker offer links, shared by the manager's own tap from the sandbox Outbox with a
  `wa.me` deep link and the message pre-filled. No WhatsApp Business API, no sending from the server, and the link is never
  logged, stored or sent to our server by the share button.
