// The ad-hoc session form lives in a modal opened from the button on the
// Sessions heading; Cancel and Connect share a height.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

test('the ad-hoc form opens as a modal and Cancel closes it', async ({ page }) => {
    await installApi(page, { role: 'poweruser' });
    await page.goto('/sessions.html');
    await settle(page);
    const modal = page.locator('#adhoc-modal');
    await expect(modal).not.toHaveClass(/active/);
    const btn = page.locator('#new-session-btn');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(modal).toHaveClass(/active/);
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#adhoc-modal-title')).toBeVisible();
    await expect(page.locator('#session-form')).toBeVisible();

    const [ok, cancel] = await Promise.all([
        page.locator('#connect-btn').boundingBox(),
        page.locator('#adhoc-cancel').boundingBox()
    ]);
    expect(Math.abs(ok.height - cancel.height), 'Connect and Cancel must be the same height').toBeLessThanOrEqual(1);

    await page.locator('#adhoc-cancel').click();
    await expect(modal).not.toHaveClass(/active/);
});

test('a viewer gets no ad-hoc button', async ({ page }) => {
    await installApi(page, { role: 'viewer' });
    await page.goto('/sessions.html');
    await settle(page);
    await expect(page.locator('#new-session-btn')).toBeHidden();
});
