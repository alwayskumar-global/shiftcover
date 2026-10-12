'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { MeResponse } from '@/api/dto';

const MeContext = createContext<MeResponse | null>(null);

/** The signed-in manager, venue and form config, loaded once on the server by the console layout. */
export function MeProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe must be used inside the console layout');
  return me;
}
