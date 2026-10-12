# Licenses

ShiftCover Pay design package. Everything below is redistributable under an open-source license compatible with this repository (Apache-2.0).

## Fonts (SIL Open Font License 1.1)

| Font | Role | Source | License |
|---|---|---|---|
| Bricolage Grotesque | Display: headlines, money | Google Fonts | OFL 1.1 |
| Public Sans | UI and body text | Google Fonts | OFL 1.1 |
| IBM Plex Mono | Times, ids, PayPal references | Google Fonts | OFL 1.1 |

The OFL permits bundling and redistribution with software. The fonts may not be sold on their own. Keep each font's copyright and license notice if you self-host the files. The prototype loads them from the Google Fonts CDN; for production, self-host the WOFF2 files to remove the third-party request.

## Icons

| Set | Use | Source | License |
|---|---|---|---|
| Lucide | All UI icons, 24px grid, 2px stroke | lucide.dev | ISC (a few icons derived from Feather are MIT) |

Icons are shipped as an SVG sprite (`icons.svg`) referenced with `<use href="icons.svg#i-name">`. Keep the Lucide license notice in the repository.

## Not covered by this repository's license

| Item | Note |
|---|---|
| Bryntum Scheduler | Commercial component. It is NOT open source and its source or CSS must not be committed to a public repo. Use a licensed or trial copy installed from npm. Only our override stylesheet (`bryntum-theme.css`) is ours. |
| PayPal JS SDK | Loaded from PayPal at runtime. We do not draw or restyle PayPal's button or logo; the design reserves a slot only. |

## What we did not use

No stock photography. No third-party illustrations. No emoji. Initials avatars are plain CSS.
