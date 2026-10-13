// The global search lifts the brand row above its own results overlay. A
// page modal (the ad-hoc session dialog, the folder and entry dialogs) must
// still cover the search box: nothing from the search chrome may sit on top
// of an open modal.
import { test, expect } from '@playwright/test';
import { installApi, settle } from '../lib/api.mjs';

async function topElementAt(page, locator) {
    const box = await locator.boundingBox();
    return page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return { id: el && el.id, closestModal: !!(el && el.closest('.modal-overlay')), tag: el && el.tagName };
    }, [box.x + box.width / 2, box.y + box.height / 2]);
}

test('the ad-hoc session modal covers the global search box', async ({ page }) => {
    await installApi(page, { role: 'poweruser' });
    await page.goto('/sessions.html');
    await settle(page);
    const search = page.locator('#rg-search');
    await expect(search).toBeVisible();
    await page.locator('#new-session-btn').click();
    await expect(page.locator('#adhoc-modal')).toHaveClass(/active/);
    const top = await topElementAt(page, search);
    expect(top.closestModal, `the modal overlay must be on top, found ${top.tag}#${top.id}`).toBe(true);
    // And the search box cannot be typed into while the modal is open.
    await page.keyboard.press('/');
    await expect(search).not.toBeFocused();
});

test('the folder modal on connections covers the global search box', async ({ page }) => {
    await installApi(page, { role: 'admin' });
    await page.goto('/connections.html');
    await settle(page);
    await page.locator('#btn-new-folder').click();
    await expect(page.locator('#folder-modal')).toHaveClass(/active/);
    const top = await topElementAt(page, page.locator('#rg-search'));
    expect(top.closestModal).toBe(true);
});
