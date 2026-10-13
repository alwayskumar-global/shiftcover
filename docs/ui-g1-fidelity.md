# Gate 1 fidelity report

Method: `npm run e2e:review -- fidelity` renders every `/review` scene (real screens, fixture data) and the matching `design/g1`
reference page (`*.dc.html` with its `#state` hash), and saves them side by side (ours left, design right) under
`e2e/.fidelity/` (local only, not committed). Page heights are recorded for both. The design was **not** changed to hide any
difference below. CSS is byte-identical to `design/g1` for `tokens.css`, `components.css`, `bryntum-theme.css`; `console.css`
differs only by the removed mock-only `.sc-ev--s*/l*` position classes; `src/styles/overrides.css` holds the additions below.

## Not product differences (capture artefacts)

- **Icons are missing in the design captures.** The reference pages load `icons.svg` through `<use href>`, which headless Chromium
  refuses from `file://`. Ours render icons from `/icons.svg`. Wordmark mark, nav, badges, timeline nodes, buttons all show this.
- **Dev indicator.** A round "N" badge (Next.js dev overlay) sits bottom-left in our captures. It does not exist in a production build.
- **Review chrome.** The design pages sit inside a device frame (rounded corners, status bar "6:49 / 5G" on W1/W2). We crop the
  frame, not the product.
- **Live values.** Countdowns tick (W1 shows 14:58 vs the design's frozen 12:39).

## Differences to review

### Added to the design (`src/styles/overrides.css`)

1. `.sc-alert--pending`: the design uses the class on M4 banners but defines no rule. Mapped to the `--sc-st-pending-*` tokens.
2. `.sc-login { min-height: 100vh }`: the design draws sign in inside a 900 px frame; in a real window the page must fill it (ours
   showed a white band under the card before this).

### Data and copy that come from fixtures, not from the design's mock

3. **Names, counts and dates** differ everywhere: roster rows (5 resources vs the design's 10), tile numbers, "Today" instead of
   "Mon, Oct 12" in the M4 header (we say "Today" when the shift is today), worker lists on M4.
4. **M2 populated** shows an offering gap and no open gap, so the red open-gap row and "Shift needs cover" caption appear only in
   `m2-open-gap`. The design's populated state has both.
5. **M2 time axis**: ours fits the shift range of the loaded day (5 AM to 5 PM); the design axis runs 5 AM to 10 PM. Ours has no
   "Now 6:49 AM" flag above the line (the flag overlaps the header; see Bryntum notes) and its row header reads "Team 5".
6. **M4 wave copy**: the API has no wave schedule, so we cannot print "Sends 6:52 AM" or "Goes out in 3 min". The wave 3 tag
   reads "Sends next" and the banner reads "The next wave goes out at $26.40/hr, the cap, ... unless someone claims first."
7. **M4 sample text** that the design hard-codes ("Jordan claimed at 6:49 AM", "$212.30" charge) is computed from fixture data.
   The capture-declined amount is `worker_pay + platform_fee` from the payment, so it differs from the design's number.
8. **M3 "From your note"** tags on rate say "Role default" only when `base_rate_source` is `role_default`; the design always says so.

### Deliberate behaviour differences

9. **M3 PayPal slot**: the design's dashed rectangle reads "PayPal button renders here · 52px · click to simulate". Ours reads
   "Test mode: approve hold without PayPal" in stub mode on non-production builds, and shows a loading slot otherwise
   (`#paypal-button-container`, reserved for the SDK in M2). The design says to drop the dashed outline once the SDK owns the button.
10. **M4 "Widen the cap" / "Raise the cap"** are rendered but inert (tooltip "Available once PayPal approval is connected"); the cap
    dialog is not built in Gate 1.
11. **M4 offers table** shows a "No offers sent yet" row when there are none (the design always has rows).
12. **M4 error and missing states**: a "We couldn't find that gap" panel and a load-error alert were added (the design has neither).
13. **M3 confirm button** keeps `aria-disabled` but still handles the click so the validation errors appear, as the design's
    script does.
14. **Sign in** posts (`method="post"`) if submitted before the page hydrates, so credentials can never land in the URL.

### Measured heights (ours / design, px)

| Scene        | Ours | Design | Scene        | Ours | Design |
| ------------ | ---- | ------ | ------------ | ---- | ------ |
| m1 default   | 900  | 900    | m4 offering  | 1674 | 1678   |
| m2 loaded    | 916  | 974    | m4 filled    | 1599 | 1546   |
| m2 no gaps   | 916  | 1064   | m4 unfilled  | 1810 | 2042   |
| m3 empty     | 1052 | 1036   | m4 cancelled | 1446 | 1507   |
| m3 confirmed | 1040 | 1024   | w1 available | 860  | 844    |
| m3 approved  | 1156 | 1140   | w1 rising    | 868  | 933    |

M3 is 16 px taller than the design in every state and W1 available states are 16 px taller than the 844 px frame; the cause
of the 16 px was not investigated. M2 and M4 differences follow the fixture row and offer counts.

## Accessibility (axe, WCAG 2.0/2.1/2.2 A and AA, every `/review` state)

`npm run e2e:review -- axe`: 34 scenes. Fixed along the way: the roster legend used `role="list"` without list items (now
`role="group"`), and the M3 confirm button could not be activated to reveal errors.

**Remaining (documented, not hidden):** `aria-required-children` (critical) on the three loaded roster scenes. It is Bryntum's
own grid markup (`role="grid"` containing `role="button"` event elements). It cannot be changed without patching the vendor
bundle; it is allow-listed by scene in `e2e/review/axe.spec.ts`.

Axe checks static rules only. Not covered: screen reader walkthroughs, focus order on the Bryntum grid, colour contrast of states
that only appear mid-transition.

## Bryntum trial behaviour (roster)

- Installed as `@bryntum/scheduler` aliased to `@bryntum/scheduler-trial@7.3.7` plus `@bryntum/scheduler-react@7.3.7`; no registry login.
- No trial watermark or licence banner was observed in the page. Not hidden or suppressed in any way. The trial build may show one
  in contexts we did not exercise.
- Dev console prints "Bryntum v7 CSS issues detected: No Font Awesome fonts detected, loading from CDN". We keep the design's own
  theme (`bryntum-theme.css`) and did not add Font Awesome or disable the check; it is a warning, not an error.
- The "Now" flag overlaps the top of the header slightly.
- Week view uses `dayAndWeek` as an approximation of the design's week layout.
