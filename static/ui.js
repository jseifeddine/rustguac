/*
 * Themed dialogs — replacements for the browser's native alert() / confirm().
 *
 * Self-contained: injects its own styles and a dialog node, using the theme
 * CSS tokens that every page defines, so it works anywhere this is loaded
 * (including the standalone client page). Promise-based, since a styled modal
 * can't block the thread the way the native ones do.
 *
 *   rgConfirm('Delete this entry?', { danger: true }).then(function (ok) { ... });
 *   rgAlert('Popup blocked.').then(function () { ... });
 */
(function () {
    'use strict';
    if (window.rgConfirm) return;

    function injectStyle() {
        if (document.getElementById('rg-dialog-style')) return;
        var css = [
            '#rg-dialog-overlay{display:none;position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,.6);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);justify-content:center;align-items:center;font-family:monospace}',
            '#rg-dialog-overlay.open{display:flex}',
            '#rg-dialog{background:var(--surface,#16213e);border:1px solid var(--border,#333);border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.6);min-width:340px;max-width:min(520px,calc(100vw - 32px));padding:var(--s-5,28px);animation:rg-dialog-in 120ms ease-out both}',
            '@keyframes rg-dialog-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
            '#rg-dialog-title{color:var(--primary,#e94560);font-size:var(--fz-lg,20px);font-weight:bold;letter-spacing:.06em;text-transform:uppercase;margin:0 0 var(--s-3,14px);padding-bottom:var(--s-2,8px);border-bottom:1px solid var(--border,#333)}',
            '#rg-dialog-message{color:var(--text,#e0e0e0);font-size:var(--fz-md,18px);line-height:1.55;white-space:pre-wrap;word-break:break-word}',
            '#rg-dialog-actions{display:flex;justify-content:flex-end;gap:var(--s-2,8px);margin-top:var(--s-5,28px)}',
            '#rg-dialog-actions button{height:var(--ctl-md,44px);padding:0 var(--s-4,20px);border-radius:var(--radius,2px);font-family:monospace;font-size:var(--fz-md,18px);font-weight:bold;cursor:pointer;border:1px solid transparent;box-sizing:border-box;line-height:1}',
            '#rg-dialog-ok{background:var(--primary,#e94560);border-color:var(--primary,#e94560);color:var(--text-on-primary,#fff)}',
            '#rg-dialog-ok:hover{background:var(--primary-hover,#c73652);border-color:var(--primary-hover,#c73652)}',
            '#rg-dialog-overlay.safe #rg-dialog-ok{background:var(--accent,#5bc0be);border-color:var(--accent,#5bc0be);color:var(--bg,#1a1a2e)}',
            '#rg-dialog-overlay.safe #rg-dialog-ok:hover{background:var(--accent-hover,#4aa3a1);border-color:var(--accent-hover,#4aa3a1)}',
            '#rg-dialog-cancel{background:transparent;color:var(--text-muted,#aaa);border-color:var(--border,#333);font-weight:normal}',
            '#rg-dialog-cancel:hover{background:var(--input,#0f3460);color:var(--text,#e0e0e0);border-color:var(--text-muted,#aaa)}',
            '#rg-dialog button:focus-visible{outline:2px solid var(--accent,#5bc0be);outline-offset:2px}'
        ].join('');
        var st = document.createElement('style'); st.id = 'rg-dialog-style'; st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    }

    var overlay, titleEl, msgEl, okBtn, cancelBtn, current = null, prevFocus = null;

    function build() {
        if (overlay) return;
        injectStyle();
        overlay = document.createElement('div');
        overlay.id = 'rg-dialog-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML =
            '<div id="rg-dialog" aria-labelledby="rg-dialog-title">' +
            '<div id="rg-dialog-title"></div>' +
            '<div id="rg-dialog-message"></div>' +
            '<div id="rg-dialog-actions">' +
            '<button type="button" id="rg-dialog-cancel"></button>' +
            '<button type="button" id="rg-dialog-ok"></button>' +
            '</div></div>';
        document.body.appendChild(overlay);
        titleEl = overlay.querySelector('#rg-dialog-title');
        msgEl = overlay.querySelector('#rg-dialog-message');
        okBtn = overlay.querySelector('#rg-dialog-ok');
        cancelBtn = overlay.querySelector('#rg-dialog-cancel');
        okBtn.addEventListener('click', function () { done(true); });
        cancelBtn.addEventListener('click', function () { done(false); });
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) done(false); });
        document.addEventListener('keydown', function (e) {
            if (!current) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
        }, true);
    }

    function done(result) {
        if (!current) return;
        var resolve = current.resolve, isConfirm = current.isConfirm;
        current = null;
        overlay.classList.remove('open');
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
        resolve(isConfirm ? result : undefined);
    }

    function show(opts) {
        build();
        return new Promise(function (resolve) {
            current = { resolve: resolve, isConfirm: !!opts.isConfirm };
            titleEl.textContent = opts.title || (opts.isConfirm ? 'Confirm' : 'Notice');
            msgEl.textContent = opts.message == null ? '' : String(opts.message);
            okBtn.textContent = opts.confirmText || (opts.isConfirm ? 'Confirm' : 'OK');
            if (opts.isConfirm) { cancelBtn.style.display = ''; cancelBtn.textContent = opts.cancelText || 'Cancel'; }
            else { cancelBtn.style.display = 'none'; }
            // danger (destructive) keeps the primary red; safe actions go accent.
            overlay.classList.toggle('safe', !!opts.safe && !opts.danger);
            prevFocus = document.activeElement;
            overlay.classList.add('open');
            setTimeout(function () { try { okBtn.focus(); } catch (e) {} }, 0);
        });
    }

    window.rgConfirm = function (message, opts) {
        opts = opts || {};
        return show({ isConfirm: true, message: message, title: opts.title, confirmText: opts.confirmText, cancelText: opts.cancelText, danger: opts.danger, safe: opts.safe });
    };
    window.rgAlert = function (message, opts) {
        opts = opts || {};
        return show({ isConfirm: false, message: message, title: opts.title, confirmText: opts.okText || opts.confirmText });
    };
})();
