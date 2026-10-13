import Link from 'next/link';
import { SCENES } from '@/review/fixtures';

/** Review index (UI_REVIEW=true only): one link per screen state. Not part of the product. */
export default function ReviewIndex() {
  const groups = [...new Set(SCENES.map((s) => s.group))];
  return (
    <main style={{ padding: 24, font: '16px/1.5 system-ui', maxWidth: 720 }}>
      <h1>Gate 1 review harness</h1>
      <p>Every screen state, rendered from fixtures. Fixture data, not a real backend.</p>
      {groups.map((g) => (
        <section key={g}>
          <h2>{g}</h2>
          <ul>
            {SCENES.filter((s) => s.group === g).map((s) => (
              <li key={s.id}>
                <Link href={`/review/${s.id}`}>{s.label}</Link> <code>{s.id}</code>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
