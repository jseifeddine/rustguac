// #254: the sidebar lists one folder per customer and gets long. A live
// filter box narrows it, the tree is keyboard-navigable with ARIA roles,
// and 'f' focuses the filter like '/' focuses the search.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

async function visibleFolderNames(page) {
    return page.locator('.folder-row:visible .folder-name').allInnerTexts();
}

test('typing in the filter box narrows the folder list live', async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    const filter = page.locator('#folder-filter');
    await expect(filter).toBeVisible();
    expect((await visibleFolderNames(page)).length).toBe(22);

    await filter.fill('tenant-1');
    const names = await visibleFolderNames(page);
    // tenant-10 … tenant-19
    expect(names.length).toBe(10);
    expect(names.every(n => /^tenant-1/.test(n))).toBe(true);

    await filter.fill('beta');
    expect(await visibleFolderNames(page)).toEqual(['beta']);

    // The description is searched too.
    await filter.fill('Tenant 20');
    expect(await visibleFolderNames(page)).toEqual(['tenant-20']);

    await filter.fill('');
    expect((await visibleFolderNames(page)).length).toBe(22);
});

test('the tree has ARIA roles and arrow keys move the selection', async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    await expect(page.locator('[role="tree"]')).toHaveCount(1);
    expect(await page.locator('[role="treeitem"]').count()).toBe(22);

    // Focus the first item, step down twice, Enter opens that folder.
    const first = page.locator('[role="treeitem"]').first();
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const focused = await page.evaluate(() => document.activeElement.getAttribute('role'));
    expect(focused).toBe('treeitem');
    await page.keyboard.press('Enter');
    await expect(page.locator('#entries-title')).toHaveText(/tenant-01/);
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);

    // End jumps to the last folder, Home back to the first.
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.activeElement.textContent)).toMatch(/tenant-20/);
    await page.keyboard.press('Home');
    expect(await page.evaluate(() => document.activeElement.textContent)).toMatch(/acme|Dani/);
});

test("'f' focuses the filter box, Escape clears it", async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('f');
    await expect(page.locator('#folder-filter')).toBeFocused();
    await page.keyboard.type('tenant-20');
    expect(await visibleFolderNames(page)).toEqual(['tenant-20']);
    await page.keyboard.press('Escape');
    await expect(page.locator('#folder-filter')).toHaveValue('');
    expect((await visibleFolderNames(page)).length).toBe(22);
});
