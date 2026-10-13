import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { SCENES } from '../../src/review/fixtures';
import { openScene } from './steps';

/** Violations accepted for now, each documented in docs/ui-g1-fidelity.md ("Accessibility"). Keyed by scene id. */
// Bryntum's own grid markup: role=grid containing role=button event elements. Third-party DOM; cannot be changed
// without patching the vendor bundle.
const BRYNTUM = ['aria-required-children'];
const KNOWN: Record<string, string[]> = {
  'm2-loaded': BRYNTUM,
  'm2-open-gap': BRYNTUM,
  'm2-no-gaps': BRYNTUM,
};

const found: Record<
  string,
  Array<{ id: string; impact: string | null | undefined; nodes: number; help: string }>
> = {};

for (const scene of SCENES) {
  test(`axe: ${scene.id}`, async ({ page }) => {
    await openScene(page, scene);
    const res = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    found[scene.id] = res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      help: v.help,
    }));
    mkdirSync('e2e/.out', { recursive: true });
    writeFileSync('e2e/.out/axe-' + scene.id + '.json', JSON.stringify(found[scene.id], null, 2));
    const unexpected = found[scene.id]!.filter((v) => !(KNOWN[scene.id] ?? []).includes(v.id));
    expect(unexpected, JSON.stringify(unexpected)).toEqual([]);
  });
}
