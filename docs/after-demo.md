# Planned after the demo

Decisions recorded so the demo scope stays small. None of these is built yet, except where a line says otherwise.

- **Gemini** is no longer on this list: gap intake and "why this worker" are built. See [`m3-gemini.md`](m3-gemini.md).
- **Widen the cap.** Raising the maximum premium needs an extra PayPal hold approved by the manager. The control is shown
  disabled with the label "Coming soon" on the gap page and has no dialog and no API call until it is built.
- **WhatsApp (option B).** Only per-worker offer links, shared by the manager's own tap from the sandbox Outbox with a
  `wa.me` deep link and the message pre-filled. No WhatsApp Business API, no sending from the server, and the link is never
  logged, stored or sent to our server by the share button.
