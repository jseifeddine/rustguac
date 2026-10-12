#!/usr/bin/env node
/*
 * Pins the framebuffer fit in client.html (#251).
 *
 * Windows RDP rounds the requested width down to a multiple of 16, so a
 * 1710-wide window gets a 1696-wide desktop and the uniform fit leaves a
 * 14px strip. applyFill() decides what happens to that strip, and the two
 * rules it carries are exactly the ones pletch asked for on #251: a
 * pixel-exact picture (scale x devicePixelRatio == 1) is never stretched,
 * because any resampling would soften text; a picture that is already being
 * resampled fills a gap of at most 2.5% on each axis, because that costs no
 * sharpness; a bigger gap is a real aspect mismatch and keeps the letterbox.
 *
 * The function lives inline in static/client.html, so it is lifted out of
 * the page text here and run on a stand-in element. If it moves or is
 * renamed this test says so rather than silently testing nothing.
 *
 * Usage: node tests/client-fit.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'static/client.html'), 'utf8');

function lift(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name}() must exist in client.html`);
    let i = html.indexOf('{', start), depth = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) break;
    }
    return html.slice(start, i + 1);
}

const fillMax = html.match(/var FILL_MAX = ([0-9.]+);/);
assert.ok(fillMax, 'FILL_MAX must be defined in client.html');

const ctx = { fillX: 1, fillY: 1 };
vm.createContext(ctx);
vm.runInContext(`var FILL_MAX = ${fillMax[1]};\n${lift('applyFill')}`, ctx);

function fit(w, h, availW, availH, pixelExact) {
    const el = { style: {} };
    vm.runInContext('fillX = 1; fillY = 1;', ctx);
    ctx.applyFill(el, w, h, availW, availH, pixelExact);
    return { fillX: ctx.fillX, fillY: ctx.fillY, transform: el.style.transform || '' };
}

// 1696 drawn into 1710: a 0.8% shortfall.
let r = fit(1696, 960, 1710, 960, /* pixelExact */ true);
assert.equal(r.fillX, 1, 'a pixel-exact picture is never stretched');
assert.equal(r.fillY, 1);
assert.equal(r.transform, '', 'no transform on a pixel-exact picture');

r = fit(1696, 960, 1710, 960, false);
assert.ok(Math.abs(r.fillX - 1710 / 1696) < 1e-9, 'a resampled picture fills a small horizontal gap');
assert.equal(r.fillY, 1, 'the height already matched');
assert.match(r.transform, /^scale\(/, 'the fill is applied as a transform');

// Both axes short by a little: both filled.
r = fit(1696, 944, 1710, 960, false);
assert.ok(r.fillX > 1 && r.fillY > 1);

// A 10% gap is an aspect mismatch, not rounding: letterbox, no stretch.
r = fit(1536, 960, 1710, 960, false);
assert.equal(r.fillX, 1, 'a gap over 2.5% keeps the letterbox');
assert.equal(r.fillY, 1);

// Nothing to fill when the picture already fits or overflows.
r = fit(1710, 960, 1710, 960, false);
assert.equal(r.fillX, 1); assert.equal(r.fillY, 1);
r = fit(1800, 960, 1710, 960, false);
assert.equal(r.fillX, 1, 'never shrink through the fill');

// The threshold itself: exactly 2.5% fills, just over does not.
r = fit(1000, 1000, 1025, 1000, false);
assert.ok(r.fillX > 1, '2.5% is still a rounding gap');
r = fit(1000, 1000, 1026, 1000, false);
assert.equal(r.fillX, 1, 'over 2.5% is not');

console.log('client-fit: ok');
