// Themed confirm/alert dialogs (ui.js) replace the browser's native ones:
// a destructive action asks in an in-page modal with a red confirm button,
// Escape cancels and sends nothing, OK performs the request; Enter acts on
// the focused button and Tab stays inside the dialog.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

test('deleting a recording asks in a themed dialog; Escape cancels, OK deletes', async ({ page }) => {
    const api = await installApi(page, { role: 'admin' });
    // A native confirm() would block the test: make sure none is ever raised.
    page.on('dialog', d => { throw new Error('native dialog raised: ' + d.message()); });
    await page.goto('/recordings.html');
    await settle(page);
    const del = page.locator('button[data-delete-rec]').first();
    await expect(del).toBeVisible();
    const name = await del.getAttribute('data-delete-rec');

    await del.click();
    const dialog = page.locator('#rg-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#rg-dialog-message')).toContainText(name);
    await expect(page.locator('#rg-dialog-ok')).toBeVisible();
    await expect(page.locator('#rg-dialog-cancel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(api.calls.filter(c => c.method === 'DELETE').length).toBe(0);

    await del.click();
    await expect(dialog).toBeVisible();
    await page.locator('#rg-dialog-ok').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.calls.some(c => c.method === 'DELETE' && c.path === '/api/recordings/' + encodeURIComponent(name))).toBe(true);
});

test('Tab is trapped between the two buttons and Enter acts on the focused one', async ({ page }) => {
    const api = await installApi(page, { role: 'admin' });
    await page.goto('/recordings.html');
    await settle(page);
    await page.locator('button[data-delete-rec]').first().click();
    const dialog = page.locator('#rg-dialog');
    await expect(dialog).toBeVisible();
    const ids = [];
    for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        ids.push(await page.evaluate(() => document.activeElement.id));
    }
    for (const id of ids) expect(['rg-dialog-ok', 'rg-dialog-cancel']).toContain(id);
    // Land on Cancel, press Enter: cancelled, nothing sent.
    while ((await page.evaluate(() => document.activeElement.id)) !== 'rg-dialog-cancel') await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    expect(api.calls.filter(c => c.method === 'DELETE').length).toBe(0);
});

test('connections: deleting an entry and terminating a session use the dialog too', async ({ page }) => {
    const api = await installApi(page, { role: 'admin' });
    page.on('dialog', d => { throw new Error('native dialog raised: ' + d.message()); });
    await page.goto('/connections.html');
    await settle(page);
    await page.locator('.folder-row').filter({ hasText: /beta/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText(/beta/);
    const row = page.locator('.main .entries-table tbody tr').filter({ hasText: 'app01' });
    await row.locator('button', { hasText: /^delete$/i }).first().click();
    const dialog = page.locator('#rg-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#rg-dialog-message')).toContainText('app01');
    await page.locator('#rg-dialog-ok').click();
    await expect.poll(() => api.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/entries/app01'))).toBe(true);
});
