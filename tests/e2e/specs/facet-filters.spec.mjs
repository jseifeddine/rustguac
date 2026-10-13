// Shared facet filters (filters.js) on the list pages: a dropdown per facet,
// multi-select with counts, combined with the text search; the selection
// persists per page in sessionStorage. One list toolbar on every page.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

async function openFacet(page, mount, label) {
    const btn = page.locator(`${mount} .rg-facet-btn`).filter({ hasText: label }).first();
    await expect(btn).toBeVisible();
    await btn.click();
    const menu = btn.locator('xpath=..').locator('.rg-facet-menu');
    await expect(menu).toBeVisible();
    return menu;
}

test('sessions: the Type facet narrows the list and the count follows', async ({ page }) => {
    await installApi(page, { role: 'admin' });
    await page.goto('/sessions.html');
    await settle(page);
    const rows = page.locator('#session-list tr');
    await expect(rows).toHaveCount(2);
    // Every list page shares the toolbar: search box, facets, action on the right.
    await expect(page.locator('#sessions .list-tools .list-search')).toBeVisible();
    await expect(page.locator('#sessions .list-tools #new-session-btn')).toBeVisible();

    const menu = await openFacet(page, '#session-filters', 'Type');
    const ssh = menu.locator('.rg-facet-opt').filter({ hasText: /ssh/i }).first();
    await expect(ssh.locator('.rg-facet-count')).toHaveText('1');
    await ssh.locator('input[type="checkbox"]').check();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('web01');

    // The selection survives a reload of the page (sessionStorage).
    await page.reload();
    await settle(page);
    await expect(page.locator('#session-list tr')).toHaveCount(1);
});

test('sessions: the search box combines with the facets', async ({ page }) => {
    await installApi(page, { role: 'admin' });
    await page.goto('/sessions.html');
    await settle(page);
    const search = page.locator('#session-search');
    await expect(search).toHaveAttribute('placeholder', /^Search sessions/);
    await search.fill('bob@');
    await expect(page.locator('#session-list tr')).toHaveCount(1);
    await expect(page.locator('#session-list tr').first()).toContainText('dc01');
    await search.fill('nobody');
    await expect(page.locator('#session-list tr')).toHaveCount(0);
});

test('recordings and reports carry the shared facets and the type badge', async ({ page }) => {
    await installApi(page);
    await page.goto('/recordings.html');
    await settle(page);
    await expect(page.locator('#rec-filters .rg-facet-btn').first()).toBeVisible();
    await expect(page.locator('#rec-search')).toHaveAttribute('placeholder', /^Search recordings/);
    await expect(page.locator('#recording-list .type-badge').first()).toBeVisible();
    const menu = await openFacet(page, '#rec-filters', 'Type');
    await menu.locator('.rg-facet-opt').filter({ hasText: /rdp/i }).locator('input').check();
    await expect(page.locator('#recording-list tbody tr')).toHaveCount(1);
    await expect(page.locator('#recording-list tbody tr').first()).toContainText('dc01');

    await page.goto('/reports.html');
    await settle(page);
    await expect(page.locator('#history-filters .rg-facet-btn').first()).toBeVisible();
    await expect(page.locator('#export-csv-btn')).toBeVisible();
    const m2 = await openFacet(page, '#history-filters', 'Type');
    await m2.locator('.rg-facet-opt').filter({ hasText: /ssh/i }).locator('input').check();
    await expect(page.locator('#history-body tr')).toHaveCount(1);
    await expect(page.locator('#history-body tr').first()).toContainText('web01');
});

test('connections: the Type facet in the folder header filters the entries table', async ({ page }) => {
    await installApi(page);
    await page.goto('/connections.html');
    await settle(page);
    await page.locator('.folder-row').filter({ hasText: /acme/ }).first().click();
    await expect(page.locator('.main .entries-table tbody tr')).toHaveCount(4);
    const menu = await openFacet(page, '#entries-filters', 'Type');
    await menu.locator('.rg-facet-opt').filter({ hasText: /rdp/i }).locator('input').check();
    await expect(page.locator('.main .entries-table tbody tr')).toHaveCount(2);
    // The folder header stays pinned at the top of the entries pane.
    const pos = await page.locator('#entries-header').evaluate(el => getComputedStyle(el).position);
    expect(pos).toBe('sticky');
});
