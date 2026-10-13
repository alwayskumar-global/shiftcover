import { Bricolage_Grotesque, IBM_Plex_Mono, Public_Sans } from 'next/font/google';

// The three families named by the design (all SIL OFL 1.1), self-hosted by next/font at build time.
export const display = Bricolage_Grotesque({
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-display',
});
export const body = Public_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-body' });
export const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-mono',
});
