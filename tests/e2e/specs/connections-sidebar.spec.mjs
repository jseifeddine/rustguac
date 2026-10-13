// #254: with 20+ tenant folders the sidebar shared the page scroll with the
// entries table, picking a folder far down the list changed content off
// screen, and nothing drew the eye to the changed title. The sidebar must
// scroll on its own, the chosen row must be marked and kept in view, and
// selecting a folder must not scroll the page.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

// Short viewport so the 22-folder list is longer than the sidebar.
test.use({ viewport: { width: 1400, height: 600 } });

test('the sidebar scrolls independently of the page', async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    const m = await sidebar.evaluate(el => ({
        overflowY: getComputedStyle(el).overflowY,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
    }));
    expect(['auto', 'scroll']).toContain(m.overflowY);
    expect(m.scrollHeight, 'the folder list must overflow the sidebar box').toBeGreaterThan(m.clientHeight);
    // Scrolling the sidebar moves the sidebar, not the document.
    await sidebar.evaluate(el => { el.scrollTop = 400; });
    const after = await page.evaluate(() => ({
        sidebarTop: document.querySelector('.sidebar').scrollTop,
        pageTop: document.scrollingElement.scrollTop
    }));
    expect(after.sidebarTop).toBeGreaterThan(0);
    expect(after.pageTop).toBe(0);
});

test('selecting a folder marks the row and keeps it in view', async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    const row = page.locator('.folder-row').filter({ hasText: /tenant-18/ }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect(page.locator('#entries-title')).toHaveText(/tenant-18/);
    // The tree marks the chosen node (the row's list item) as selected.
    await expect(row.locator('xpath=ancestor::li[1]')).toHaveClass(/selected/);
    const vis = await row.evaluate(el => {
        const r = el.getBoundingClientRect();
        const s = el.closest('.sidebar').getBoundingClientRect();
        return { inside: r.top >= s.top - 1 && r.bottom <= s.bottom + 1 };
    });
    expect(vis.inside, 'the selected row must be within the sidebar viewport').toBe(true);
    // Whether the page itself may move on selection is the app shell's
    // business: connections-app-shell.spec.mjs pins that it does not.
});

test('leaf folders start flush left: no chevron placeholder before the name', async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    // No fixture folder has children, so no row may carry a chevron.
    expect(await page.locator('.folder-row .tree-chevron').count()).toBe(0);
});
