'use client';

import dynamic from 'next/dynamic';
import type { Scene } from './fixtures';

const ReviewScene = dynamic(() => import('./ReviewScene').then((m) => m.ReviewScene), {
  ssr: false,
});

export function ReviewSceneClient({ scene }: { scene: Scene }) {
  return <ReviewScene scene={scene} />;
}
