// Ad-hoc connections moved out of Sessions (#295): the old form and its
// button are gone, and the global "Connect to a host" button beside the
// search box takes a poweruser from here to the ad-hoc editor on
// Connections.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

test('Sessions has no ad-hoc form; the global button opens the editor on Connections', async ({ page }) => {
    await installApi(page, { role: 'poweruser' });
    await page.goto('/sessions.html');
    await settle(page);
    await expect(page.locator('#adhoc-modal')).toHaveCount(0);
    await expect(page.locator('#session-form')).toHaveCount(0);
    await expect(page.locator('#new-session-btn')).toHaveCount(0);

    await page.locator('#rg-adhoc').click();
    await page.waitForURL(/\/connections\.html/);
    await settle(page);
    const modal = page.locator('#entry-modal');
    await expect(modal).toHaveClass(/active/);
    await expect(modal).toHaveClass(/adhoc/);
    await expect(page.locator('#em-connect')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
});
