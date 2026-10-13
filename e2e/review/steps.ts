import type { Page } from '@playwright/test';
import type { Scene } from '../../src/review/fixtures';

/** Opens a scene at its viewport and applies its steps. Shared by the axe and fidelity runs. */
export async function openScene(page: Page, scene: Scene) {
  await page.setViewportSize(scene.viewport);
  await page.goto(`/review/${scene.id}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  for (const step of scene.steps ?? []) {
    if ('fill' in step) await page.locator(step.fill).fill(step.value);
    else if ('select' in step) await page.locator(step.select).selectOption(step.value);
    else if ('click' in step) await page.locator(step.click).first().click({ force: step.force });
    else await page.waitForTimeout(step.wait);
  }
  await page.waitForTimeout(400);
}
