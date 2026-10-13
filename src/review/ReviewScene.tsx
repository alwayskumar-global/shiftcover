'use client';

import { useState } from 'react';
import { GapDetailScreen } from '@/features/manager/GapDetailScreen';
import { ConsoleShell } from '@/features/manager/ConsoleShell';
import { LoginExperience } from '@/features/manager/LoginExperience';
import { ReportGapScreen } from '@/features/manager/ReportGapScreen';
import { RosterScreen } from '@/features/manager/RosterScreen';
import { ClaimExperience } from '@/features/worker/ClaimExperience';
import { GAP_DETAILS, ME, type Scene } from './fixtures';
import { installStubFetch } from './stub-fetch';

/** Renders one fixture scene with the real screen components. Review harness only (UI_REVIEW=true). */
export function ReviewScene({ scene }: { scene: Scene }) {
  // Client-only (see ReviewSceneClient): the stub must be in place before any child effect fetches.
  useState(() => {
    try {
      sessionStorage.clear();
    } catch {
      // storage unavailable: the scene still renders
    }
    installStubFetch(scene);
    return null;
  });

  const r = scene.render;
  switch (r.kind) {
    case 'worker':
      return <ClaimExperience token="review-token" />;
    case 'login':
      return <LoginExperience />;
    case 'roster':
      return (
        <ConsoleShell me={ME}>
          <RosterScreen />
        </ConsoleShell>
      );
    case 'gap-new':
      return (
        <ConsoleShell me={ME}>
          <ReportGapScreen />
        </ConsoleShell>
      );
    case 'gap-detail':
      return (
        <ConsoleShell me={ME}>
          <GapDetailScreen id={GAP_DETAILS[r.detail].slot.id} />
        </ConsoleShell>
      );
  }
}
