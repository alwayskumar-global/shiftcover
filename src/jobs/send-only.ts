import { PgBoss } from 'pg-boss';
import { getPool } from '../db/client';
import type { JobName } from './names';

/**
 * Web-side pg-boss: enqueue only. It reuses the web app pool through pg-boss's `db` option, so it
 * adds no connections (budget in src/db/connection.ts). No start(), supervision, scheduling, or
 * migrations here; the worker owns all of that and creates the queues.
 */
let boss: PgBoss | undefined;

function getSendOnlyBoss(): PgBoss {
  return (boss ??= new PgBoss({
    db: {
      executeSql: async (text: string, values?: unknown[]) => {
        const r = await getPool().query(text, values);
        return { rows: r.rows };
      },
    },
    supervise: false,
    schedule: false,
    migrate: false,
  }));
}

export async function enqueueFromWeb(
  name: JobName,
  data: object,
  options?: { singletonKey?: string },
) {
  return getSendOnlyBoss().send(name, data, options);
}
