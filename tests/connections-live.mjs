#!/usr/bin/env node
/*
 * Pins what the Connections page re-reads when the address book changes
 * under it.
 *
 * The page polls GET /api/addressbook/version?since=N and gets back the
 * folders that changed. livePlan() turns that into the least work that keeps
 * the view honest, and the point of it is what it does NOT do: a change in
 * a folder you are not looking at reads nothing, a change anywhere does not
 * rebuild the search index, and the folder list is re-read only when a
 * folder came or went. Those are load bounds a reviewer asked for, so they
 * are pinned here rather than left to be eroded by the next convenience.
 *
 * Usage: node tests/connections-live.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'static/connections.html'), 'utf8');

/** The source of one top-level function in the page, by brace matching. */
function lift(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} is defined in connections.html`);
    let i = html.indexOf('{', start), depth = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) break;
    }
    return html.slice(start, i + 1);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(lift('livePlan'), ctx);
// Round-tripped through JSON: arrays born in the vm context have their own
// Array prototype, which strict deep equality would otherwise reject.
const livePlan = (changes, view) => JSON.parse(JSON.stringify(ctx.livePlan(changes, view)));

const entries = (scope, folder) => ({ scope, folder, kind: 'entries' });
const tree = (scope, folder) => ({ scope, folder, kind: 'tree' });
const all = () => ({ scope: '*', folder: '', kind: 'all' });

/** A tab looking at shared|cust/acme with a few folders cached and the index built. */
const looking = (over = {}) => ({
    selectedKey: 'shared|cust/acme',
    searchActive: false,
    indexLoaded: true,
    cachedKeys: ['shared|cust', 'shared|cust/acme', 'shared|cust/acme/dc1', 'instance|lab'],
    ...over
});

// A change in the open folder re-reads that folder, and that alone.
{
    const p = livePlan([entries('shared', 'cust/acme')], looking());
    assert.deepEqual(p.fetch, ['shared|cust/acme']);
    assert.deepEqual(p.drop, []);
    assert.equal(p.tree, false, 'entries do not move the folder list');
    assert.equal(p.index, 'keep', 'the open folder re-read patches the index for free');
}

// A change elsewhere reads nothing: the cached copy is forgotten and the
// index is marked stale for when search is next used.
{
    const p = livePlan([entries('instance', 'lab')], looking());
    assert.deepEqual(p.fetch, []);
    assert.deepEqual(p.drop, ['instance|lab']);
    assert.equal(p.tree, false);
    assert.equal(p.index, 'stale');
}

// A change in a folder this tab never cached still costs nothing now.
{
    const p = livePlan([entries('shared', 'other')], looking());
    assert.deepEqual(p.fetch, []);
    assert.deepEqual(p.drop, ['shared|other']);
    assert.equal(p.index, 'stale');
}

// Several changes: each folder once, the open one read, the rest dropped.
{
    const p = livePlan(
        [entries('instance', 'lab'), entries('shared', 'cust/acme'), entries('instance', 'lab')],
        looking());
    assert.deepEqual(p.fetch, ['shared|cust/acme']);
    assert.deepEqual(p.drop, ['instance|lab']);
}

// A folder coming or going re-reads the folder list (no entries) and
// forgets what was cached under it; the open folder is untouched when it
// is elsewhere.
{
    const p = livePlan([tree('instance', 'lab')], looking());
    assert.equal(p.tree, true);
    assert.deepEqual(p.treeKeys, ['instance|lab']);
    assert.deepEqual(p.fetch, []);
    assert.deepEqual(p.drop, ['instance|lab']);
    assert.equal(p.index, 'stale', 'paths or visibility may have moved');
}

// A tree change above the open folder re-reads the open folder too (it may
// be gone, or its description changed) and drops the rest of the subtree.
{
    const p = livePlan([tree('shared', 'cust')], looking());
    assert.equal(p.tree, true);
    assert.deepEqual(p.fetch, ['shared|cust/acme']);
    assert.deepEqual(p.drop.sort(), ['shared|cust', 'shared|cust/acme/dc1']);
}

// A sibling whose name is a prefix is not "under" the changed folder.
{
    const p = livePlan([tree('shared', 'cust/ac')], looking());
    assert.deepEqual(p.fetch, []);
    assert.deepEqual(p.drop, []);
}

// `all` (or no change list at all) refreshes what is shown, once: the
// folder list and the open folder, nothing else is read.
for (const changes of [[all()], null, [entries('instance', 'lab'), all()]]) {
    const p = livePlan(changes, looking());
    assert.equal(p.tree, true);
    assert.equal(p.treeAll, true);
    assert.deepEqual(p.fetch, ['shared|cust/acme']);
    assert.deepEqual(p.drop.sort(), ['instance|lab', 'shared|cust', 'shared|cust/acme/dc1']);
    assert.equal(p.index, 'stale');
}

// Nothing changed, nothing happens.
{
    const p = livePlan([], looking());
    assert.deepEqual(p, { tree: false, treeAll: false, treeKeys: [], fetch: [], drop: [], index: 'keep' });
}

// While search results are showing, a changed folder is re-read so its rows
// in the index can be patched: bounded to the changed folders, no walk.
{
    const p = livePlan([entries('instance', 'lab')], looking({ searchActive: true }));
    assert.deepEqual(p.fetch, ['instance|lab']);
    assert.deepEqual(p.drop, []);
    assert.equal(p.index, 'keep');
}

// ...and the open folder, not on screen behind the results, is patched the
// same way rather than rendered.
{
    const p = livePlan([entries('shared', 'cust/acme')], looking({ searchActive: true }));
    assert.deepEqual(p.fetch, ['shared|cust/acme']);
    assert.equal(p.index, 'keep');
}

// A tree change while searching needs the walk (visibility may have moved):
// the index is rebuilt once and no per-folder patches are read on top.
{
    const p = livePlan([tree('instance', 'lab'), entries('shared', 'cust/acme')],
        looking({ searchActive: true }));
    assert.equal(p.index, 'rebuild');
    assert.deepEqual(p.fetch, []);
    assert.deepEqual(p.drop.sort(), ['instance|lab', 'shared|cust/acme']);
}

// Without an index built there is nothing to patch: the folder is dropped
// and the stale mark means the first search builds it.
{
    const p = livePlan([entries('instance', 'lab')], looking({ searchActive: true, indexLoaded: false }));
    assert.deepEqual(p.fetch, []);
    assert.deepEqual(p.drop, ['instance|lab']);
    assert.equal(p.index, 'stale');
}

// No folder open (nothing selected yet): a change reads nothing.
{
    const p = livePlan([entries('shared', 'x'), tree('shared', 'y')], looking({ selectedKey: null, cachedKeys: [] }));
    assert.deepEqual(p.fetch, []);
    assert.equal(p.tree, true);
}

console.log('connections-live: ok');
