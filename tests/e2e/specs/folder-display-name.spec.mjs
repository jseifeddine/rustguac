// A folder with a display name shows it as the title with the folder key as
// a sub-header, in the entries header and in the sidebar; the folder modal
// offers a Display name field.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

test('display name over the key in the header and the sidebar', async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    // The acme folder carries a display name, beta does not.
    const acme = page.locator('.folder-row').filter({ hasText: "Dani & Fiori's Gourmet Pizzeria" }).first();
    await expect(acme).toBeVisible();
    await expect(acme).toContainText('acme');
    await acme.click();
    await expect(page.locator('#entries-title')).toHaveText("Dani & Fiori's Gourmet Pizzeria");
    await expect(page.locator('#entries-key')).toHaveText('acme');

    await page.locator('.folder-row').filter({ hasText: /beta/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText('beta');
    await expect(page.locator('#entries-key')).toBeHidden();
});

test('the folder modal has a Display name field and sends it', async ({ page }) => {
    const api = await installApi(page, { role: 'admin' });
    await page.goto('/connections.html');
    await settle(page);
    await page.locator('.folder-row').filter({ hasText: /beta/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText('beta');
    await page.locator('#btn-edit-folder').click();
    const display = page.locator('#fm-display');
    await expect(display).toBeVisible();
    await display.fill('Beta Industries Pty Ltd');
    await page.locator('#folder-modal button[type="submit"], #folder-modal .btn-primary, #fm-save').first().click();
    await expect.poll(() => api.calls.some(c => c.method === 'PUT' && /\/api\/addressbook\/folders\/shared\/beta$/.test(c.path)
        && c.body && c.body.display_name === 'Beta Industries Pty Ltd')).toBe(true);
});
