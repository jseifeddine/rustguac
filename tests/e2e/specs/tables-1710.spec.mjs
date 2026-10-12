// #252: the admin table overran the page at 1710px wide and the page scrolled
// sideways. Each list page must fit its table inside the viewport at 1710px
// with nothing cut off, and the page must not scroll horizontally.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

test.use({ viewport: { width: 1710, height: 1112 } });

async function noHorizontalOverflow(page) {
    const m = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScroll: document.body.scrollWidth
    }));
    expect(m.scrollWidth, 'document must not be wider than the viewport').toBeLessThanOrEqual(m.clientWidth);
    expect(m.bodyScroll).toBeLessThanOrEqual(m.clientWidth);
}

async function tableFits(page, selector) {
    const table = page.locator(selector).first();
    await expect(table).toBeVisible();
    const box = await table.boundingBox();
    const vw = page.viewportSize().width;
    expect(box.x + box.width, `${selector} right edge must be inside the viewport`).toBeLessThanOrEqual(vw + 0.5);
}

test('connections: the entries table with admin actions fits at 1710px', async ({ page }) => {
    await installApi(page, { role: 'admin' });
    await page.goto('/connections.html');
    await settle(page);
    // Open the first tenant folder so the admin table (edit/clone/delete) renders.
    await page.locator('.folder-row').filter({ hasText: /beta/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText(/beta/);
    await expect(page.locator('.entries-table')).toBeVisible();
    await expect(page.locator('.entries-table tbody tr').first()).toBeVisible();
    await tableFits(page, '.entries-table');
    await noHorizontalOverflow(page);
});

test('recordings: the table fits at 1710px', async ({ page }) => {
    await installApi(page);
    await page.goto('/recordings.html');
    await settle(page);
    await expect(page.locator('#recording-list tbody tr').first()).toBeVisible();
    await tableFits(page, '#recording-list');
    await noHorizontalOverflow(page);
});

test('reports: the session history table fits at 1710px', async ({ page }) => {
    await installApi(page);
    await page.goto('/reports.html');
    await settle(page);
    await expect(page.locator('#history-body tr').first()).toBeVisible();
    await tableFits(page, '#history-table');
    await noHorizontalOverflow(page);
});
