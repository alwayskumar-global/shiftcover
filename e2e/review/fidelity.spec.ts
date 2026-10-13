import { test } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { SCENES } from '../../src/review/fixtures';
import { openScene } from './steps';

/**
 * Visual fidelity: each /review state beside the design/g1 reference page, side by side (ours left, design right).
 * Output: e2e/.fidelity/<scene>.png and e2e/.fidelity/heights.json. Reference-only; nothing here ships.
 */
const OUT = 'e2e/.fidelity';

/** Gate 2 reference pages sit in design/g2 and link the Gate 1 css by relative path: assemble a scratch folder (g1 files, the
 * patched tokens.css and icons.svg from the product, then the g2 files) so they render as the designer saw them. */
function referenceDir(file: string): string {
  if (!file.startsWith('G2-')) return resolve('design/g1');
  const dir = join(tmpdir(), 'shiftcover-g2-reference');
  if (!existsSync(join(dir, 'g2.css'))) {
    cpSync(resolve('design/g1'), dir, { recursive: true });
    cpSync(resolve('src/styles/tokens.css'), join(dir, 'tokens.css'));
    cpSync(resolve('public/icons.svg'), join(dir, 'icons.svg'));
    cpSync(resolve('design/g2'), dir, { recursive: true });
  }
  return dir;
}
const heights: Record<string, { ours: number; design: number | null }> = {};

for (const scene of SCENES.filter((s) => s.design)) {
  test(`fidelity: ${scene.id}`, async ({ page, browser }) => {
    mkdirSync(OUT, { recursive: true });
    await openScene(page, scene);
    const ours = await page.screenshot();
    const oursHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    const ref = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const { file, hash } = scene.design!;
    await ref.goto(`file://${resolve(referenceDir(file), file)}${hash ? '#' + hash : ''}`);
    await ref.waitForTimeout(2500);
    const frame = ref.locator('.rv-console-frame, .rv-device').first();
    for (const step of scene.steps ?? []) {
      // The design draws its own states from the hash; interaction steps are not replayed there.
      void step;
    }
    const design = await frame.screenshot();
    const designHeight = await ref.evaluate(
      () =>
        (document.querySelector('.sc-console, .sc-app') as HTMLElement | null)?.scrollHeight ?? 0,
    );
    await ref.close();
    heights[scene.id] = { ours: oursHeight, design: designHeight || null };

    const cmp = await browser.newPage({
      viewport: { width: scene.viewport.width * 2 + 40, height: scene.viewport.height + 20 },
    });
    await cmp.setContent(
      `<body style="margin:0;background:#888;display:flex;gap:40px;align-items:flex-start">
        <img src="data:image/png;base64,${ours.toString('base64')}"><img src="data:image/png;base64,${design.toString('base64')}"></body>`,
    );
    await cmp.screenshot({ path: `${OUT}/${scene.id}.png` });
    await cmp.close();
    writeFileSync(`${OUT}/heights-${scene.id}.json`, JSON.stringify(heights[scene.id]));
  });
}
