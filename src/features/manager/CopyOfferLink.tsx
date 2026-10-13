'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/primitives';

/**
 * "Copy link" for one offer on the gap detail (sandbox testing aid: the API sends `offer_link` only in the PayPal
 * sandbox). The link exists only as this component's prop: it is written to the clipboard on click and nowhere else
 * (not storage, not the URL, not the console, not analytics or an error reporter). The result is announced through a
 * polite live region, so a screen reader hears "Link copied" without the button label having to be re-read.
 */
const RESET_MS = 2000;

export function CopyOfferLink({ link, workerName }: { link: string; workerName: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(link);
      setState('copied');
    } catch {
      setState('failed'); // no clipboard access (insecure page, permission): say so; never print the link
    }
    timer.current = setTimeout(() => setState('idle'), RESET_MS);
  };

  const copied = state === 'copied';
  return (
    <>
      <Button
        variant="quiet"
        size="md"
        onClick={() => void copy()}
        aria-label={`${copied ? 'Copied' : 'Copy link'} for ${workerName}`}
      >
        <Icon name={copied ? 'i-check' : 'i-copy'} size="sm" />
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <span className="sc-visually-hidden" role="status" aria-live="polite">
        {state === 'copied' ? 'Link copied' : state === 'failed' ? "Couldn't copy the link" : ''}
      </span>
    </>
  );
}
