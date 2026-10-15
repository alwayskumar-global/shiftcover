# Licenses

ShiftCover Pay is MIT-licensed (see `LICENSE`). Third-party design assets shipped with the app:

## Fonts (SIL Open Font License 1.1)

| Font                | Role                          | Source       | License                                                                 |
| ------------------- | ----------------------------- | ------------ | ----------------------------------------------------------------------- |
| Bricolage Grotesque | Display: headlines, money     | Google Fonts | [OFL 1.1](https://openfontlicense.org/open-font-license-official-text/) |
| Public Sans         | UI and body text              | Google Fonts | [OFL 1.1](https://openfontlicense.org/open-font-license-official-text/) |
| IBM Plex Mono       | Times, ids, PayPal references | Google Fonts | [OFL 1.1](https://openfontlicense.org/open-font-license-official-text/) |

Loaded with `next/font/google`, which downloads the files at build time and serves them from our own origin (no runtime
request to Google). The OFL permits bundling and redistribution with software; the fonts may not be sold on their own.

## Icons

| Set    | Use                                                             | Source                           | License                                                                                            |
| ------ | --------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Lucide | All UI icons, 24px grid, 2px stroke (`public/icons.svg` sprite) | [lucide.dev](https://lucide.dev) | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) (a few Feather-derived icons: MIT) |

> ISC License: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
> All other copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use, copy, modify, and/or
> distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright
> notice and this permission notice appear in all copies.

## Not covered by this repository's license

| Item              | Note                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bryntum Scheduler | Commercial component, installed from npm (trial packages). Its source and CSS are not committed here. Only our override stylesheet `src/styles/bryntum-theme.css` is ours. A trial license notice may be visible in the UI; do not hide it. |
| PayPal JS SDK     | Loaded from PayPal at runtime (M2). We do not draw or restyle PayPal's button or logo.                                                                                                                                                      |

No stock photography, third-party illustrations or emoji are used.
