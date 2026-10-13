// #254: the page is an app shell. The header stays, the sidebar and the
// entries area are two independent scroll panes that always fit the
// viewport, selecting a folder scrolls the entries pane and never the page,
// and the body cannot be scrolled by script at all.
import { test, expect } from '@playwright/test';
import { installApi, settle, fixtureFolders, entry } from '../lib/api.mjs';

test.use({ viewport: { width: 1400, height: 600 } });

// A folder with enough entries to overflow the entries pane.
function longFolders() {
    const folders = fixtureFolders();
    const big = folders.find(f => f.name === 'beta');
    for (let i = 1; i <= 60; i++) big.entries.push(entry(`host-${String(i).padStart(2, '0')}`, 'ssh'));
    return folders;
}

test('the body is clipped and both panes fit the viewport', async ({ page }) => {
    await installApi(page, { folders: longFolders() });
    await page.goto('/connections.html');
    await settle(page);
    const m = await page.evaluate(() => {
        const vh = window.innerHeight;
        const side = document.querySelector('.sidebar').getBoundingClientRect();
        const main = document.querySelector('.main').getBoundingClientRect();
        return {
            bodyOverflow: getComputedStyle(document.body).overflow,
            sideBottom: side.bottom, mainBottom: main.bottom, vh,
            mainOverflowY: getComputedStyle(document.querySelector('.main')).overflowY
        };
    });
    expect(m.bodyOverflow).toBe('clip');
    expect(m.sideBottom).toBeLessThanOrEqual(m.vh + 1);
    expect(m.mainBottom).toBeLessThanOrEqual(m.vh + 1);
    expect(['auto', 'scroll']).toContain(m.mainOverflowY);
});

test('selecting a folder scrolls the entries pane to its top, never the page', async ({ page }) => {
    await installApi(page, { folders: longFolders() });
    await page.goto('/connections.html');
    await settle(page);
    await page.locator('.folder-row').filter({ hasText: /beta/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText(/beta/);
    // Scroll the entries pane down, then pick another folder: the pane goes
    // back to the top and the document never moved.
    const main = page.locator('.main');
    await main.evaluate(el => { el.scrollTop = 600; });
    expect(await main.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.locator('.folder-row').filter({ hasText: /tenant-03/ }).first().click();
    await expect(page.locator('#entries-title')).toHaveText(/tenant-03/);
    const after = await page.evaluate(() => ({
        mainTop: document.querySelector('.main').scrollTop,
        pageTop: document.scrollingElement.scrollTop,
        brandVisible: document.querySelector('.brand-row, h1').getBoundingClientRect().top >= 0
    }));
    expect(after.mainTop).toBe(0);
    expect(after.pageTop).toBe(0);
    expect(after.brandVisible, 'the brand row must not be pushed off the top').toBe(true);
});
