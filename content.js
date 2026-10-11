// ============================================
// Vaughn Emote Autocomplete Extension (content script)
// Fixed version. Key changes vs. the broken draft:
//   1. emotes is a Map now (the old code assigned string keys onto an
//      array and then read .length, which never worked).
//   2. Emotes are parsed from the DOM FIRST, with fetch() only as a
//      fallback (the old code always fetched and grabbed the wrong ID
//      for every emote because it matched against the whole HTML once).
//   3. dropdown / hiddenInput are declared before use.
//   4. Works on dynamically-rendered chat inputs via a MutationObserver.
//   5. Typing inserts text into the real input and dispatches an
//      'input' event so the site's own handlers stay in sync.
// ============================================

(() => {
  'use strict';

  const TRIGGER_CHARS = [':', '!'];       // characters that start a query
  const MAX_SUGGESTIONS = 12;
  const MIN_QUERY_LEN = 1;                // show suggestions after 1 char

  let chatInput = null;
  let emotes = new Map();                 // name(lowercase) -> emote object
  let dropdown = null;
  let activeIndex = -1;
  let currentMatches = [];
  let observer = null;

  // CRITICAL: isTopFrame() returns TRUE when we are inside a frame (the
  // chat iframe). Those frames never get the CSS injected by the manifest
  // ("css" is only applied to the top document), so we inject it ourselves.
  function ensureStyleInThisDocument(doc) {
    doc = doc || document;
    try {
      if (doc.getElementById('vaughn-emote-style')) return;
      const link = document.querySelector('link[href*="content.css"]') ||
                   doc.querySelector('link[href*="content.css"]');
      const style = doc.createElement('style');
      style.id = 'vaughn-emote-style';
      if (link) {
        fetch(link.href).then((r) => r.text()).then((t) => { style.textContent = t; }).catch(() => {});
      } else {
        style.textContent = [
          '#vaughn-emote-dropdown{position:fixed;z-index:2147483647;background:#1e1e2e;border:1px solid #444;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.4);max-height:280px;overflow-y:auto;font-family:sans-serif;font-size:14px;color:#eee;display:none}',
          '.vaughn-emote-item{padding:6px 10px;cursor:pointer}',
          '.vaughn-emote-item:hover,.vaughn-emote-active{background:#3b3b5c}',
        ].join('\n');
      }
      (doc.head || doc.documentElement).appendChild(style);
    } catch (_) {}
  }

  // The site pre-renders a small subset of emotes (e.g. "recently used") in
  // the initial DOM. We must NOT stop loading after finding those — keep
  // virtually opening the picker until we have the full list.
  const MIN_FULL_LIST = 50;               // below this, assume partial list
  let pickerEverOpened = false;           // user or virtual click rendered items
  let lastDomParseAt = 0;

  // The emoji list is NOT in the initial HTML — it only exists once the
  // user opens the emoji picker. Instead of virtually clicking the picker
  // button (which fails when the click handler is React-attached, or when
  // the button matched isn't the real toggle), we hook addEventListener on
  // every document and record which elements have a 'click' listener.
  // The element near the chat input that has BOTH an emoji-ish hint AND a
  // registered click listener is almost certainly the real toggle; we then
  // dispatch a native click on exactly that element.
  const hookedDocs = new WeakSet();
  const clickListenerTargets = new WeakSet();

  function hookDocument(doc) {
    if (!doc || hookedDocs.has(doc)) return;
    try {
      hookedDocs.add(doc);
      const win = doc.defaultView;
      if (!win) return;
      const proto = win.EventTarget && win.EventTarget.prototype;
      if (!proto || proto.__vaughnAelHooked) return;
      const origAdd = proto.addEventListener;
      proto.addEventListener = function (type, fn, opts) {
        if (type === 'click') {
          try {
            if (this instanceof win.Node) clickListenerTargets.add(this);
          } catch (_) {}
        }
        return origAdd.call(this, type, fn, opts);
      };
      proto.__vaughnAelHooked = true;
      // Elements with an onclick ATTRIBUTE (not addEventListener) are
      // detected separately via getAttribute('onclick') in findEmojiButton.
    } catch (_) { /* sandbox restrictions — ignore */ }
  }
  hookDocument(document);

  // ---- cross-frame coordination ------------------------------------------
  // If the chat lives in a CROSS-ORIGIN iframe (e.g. vaughn.live embedding a
  // streamlabs/twitch chat frame), the top frame's script cannot reach into
  // it at all. The content script DOES run inside that frame though
  // (all_frames:true), so the child posts its harvested emotes up to us via
  // window.postMessage, and we merge them into our store.
  const MSG_TAG = 'vaughn-emote-autocomplete';
  function isTopFrame() { try { return window.top === window.self; } catch (_) { return true; } }
  const pendingChildEmotes = [];   // buffered messages received before store ready

  window.addEventListener('message', (ev) => {
    if (ev.source === window) return;                 // only from child frames
    const d = ev.data;
    if (!d || d.__vaughnEmoteMsg !== MSG_TAG || !Array.isArray(d.emotes)) return;
    // Merge child-frame emotes into our store. Don't skip just because we
    // already have some — what we have may be only the pre-rendered subset.
    if (d.emotes.length > 0) {
      const before = emotes.size;
      storeEmotes(d.emotes);
      console.log(`[Vaughn Emotes] Received ${d.emotes.length} emotes from child frame (${d.frameUrl || 'cross-origin'}); total now ${emotes.size} (+${emotes.size - before}).`);
      if (emotes.size >= MIN_FULL_LIST) maybeBuildDropdown();
    } else {
      pendingChildEmotes.push(d);                      // frame opened but rendered nothing yet
    }
  });

  function postEmotesToParent(list) {
    try {
      window.parent.postMessage({
        __vaughnEmoteMsg: MSG_TAG,
        frameUrl: location.href,
        emotes: list.map((e) => ({ id: e.id, name: e.name, filename: e.filename, width: e.width, height: e.height })),
      }, '*');
    } catch (_) {}
  }

  let virtualRefreshScheduled = false;
  let lastVirtualClickAt = 0;
  const VIRTUAL_CLICK_COOLDOWN_MS = 5 * 1000;   // retry quickly, capped by MAX_ATTEMPTS
  const VIRTUAL_CLICK_MAX_ATTEMPTS = 30;        // large list (~1600) may render in chunks
  let virtualClickAttempts = 0;

  function scheduleVirtualEmoteLoad(delayMs) {
    // Continue loading while we have nothing OR only a partial (pre-rendered)
    // subset of the emote list.
    if (virtualRefreshScheduled || emotes.size >= MIN_FULL_LIST) return;
    if (Date.now() - lastVirtualClickAt < VIRTUAL_CLICK_COOLDOWN_MS) return;
    virtualRefreshScheduled = true;
    setTimeout(() => {
      virtualRefreshScheduled = false;
      virtualLoadEmotesByClickingPicker();
    }, delayMs || 2500);
  }

  // Parse emote name - remove surrounding parentheses/brackets
  const parseEmoteName = (name) => (name || '').replace(/^[\(\)\[\]:]+|[\(\)\[\]:]+$/g, '').trim();

  function isUsable(el) {
    return !!(el && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
      (el.tagName === 'INPUT' && !/hidden|checkbox|radio|submit|button|image/i.test(el.type))));
  }

  function findChatInputInDoc(doc) {
    const selectors = [
      // CONFIRMED markup from the user (vaughn.live chatv9):
      // <textarea id="vs_chatv9_input_box" class="vs_chatv9_input_box" ...>
      '#vs_chatv9_input_box',
      'textarea.vs_chatv9_input_box',
      'textarea[id*="chat" i]',
      'textarea[class*="chat" i]',
      'textarea[placeholder*="Type" i]',
      'input.vs_chatv9_input',
      '.vs_chatv9_footer input[type="text"]',
      'input[placeholder*="chat" i]',
      'input[placeholder*="message" i]',
      'input[placeholder*="Send" i]',
      '[contenteditable="true"]',
      'textarea',
      'input[type="text"]',
    ];
    for (const sel of selectors) {
      let els = [];
      try { els = doc.querySelectorAll(sel); } catch (_) { continue; }
      // Return the first *usable* match — an early selector like a generic
      // class can otherwise hit a hidden search box and shadow the textarea.
      for (const el of els) if (isUsable(el)) return el;
    }
    return null;
  }

  function findChatInput() {
    // Search our own document first, then any registered same-origin iframe
    // documents (the chat may live entirely inside one).
    const local = findChatInputInDoc(document);
    if (local) return local;
    for (const doc of foreignDocs) {
      const el = findChatInputInDoc(doc);
      if (el) return el;
    }
    try {
      const frames = document.querySelectorAll('iframe');
      for (const f of frames) {
        let cd = null;
        try { cd = f.contentDocument; } catch (_) {}
        if (!cd) continue;
        const el = findChatInputInDoc(cd);
        if (el) { registerForeignDoc(cd); return el; }
      }
    } catch (_) {}
    return null;
  }

  // Generic parser: given a NodeList of candidate emoji-item elements,
  // extract {id, name, ...} from title + onclick, whatever the exact
  // class name or attribute order happens to be.
  function extractEmotes(items) {
    return Array.from(items).map((item) => {
      const title = item.getAttribute('title') || '';
      // onclick may be an attribute OR a property set by JS (no attribute)
      const onclick = item.getAttribute('onclick') || String(item.onclick || '');
      const idMatch = onclick.match(/insertEmoji\(\s*['"]([^'"]+)['"]\s*,/);
      const img = item.querySelector('img');
      const src = img ? img.getAttribute('src') : '';

      return {
        id: idMatch ? idMatch[1] : '',
        name: parseEmoteName(title),
        filename: src ? src.split('/').pop() : '',
        width: img ? parseInt(img.getAttribute('width'), 10) || 0 : 0,
        height: img ? parseInt(img.getAttribute('height'), 10) || 0 : 0,
      };
    }).filter((e) => e.name);
  }

  // ---------- debug helper ----------
  // Dumps every "emoji-ish" element, the click-listener map near the chat
  // input, and image src patterns, so we can see what the real markup is.
  function dumpEmojiDiagnostics() {
    try {
      const info = {
        frameUrl: location.href,
        isTopFrame: window.top === window.self,
        chatInputFound: !!findChatInput(),
        emojiishElements: [],
        clickablesNearInput: [],
        imgSrcSamples: [],
      };
      document.querySelectorAll('*').forEach((el) => {
        const hay = (
          (typeof el.className === 'string' ? el.className : '') + ' ' +
          (el.id || '') + ' ' +
          (el.getAttribute('title') || '') + ' ' +
          (el.getAttribute('aria-label') || '')
        ).toLowerCase();
        if (/emoji|emote|smile/.test(hay)) {
          info.emojiishElements.push({
            tag: el.tagName, id: el.id,
            class: typeof el.className === 'string' ? el.className : '',
            title: el.getAttribute('title'), aria: el.getAttribute('aria-label'),
            children: el.children.length,
          });
        }
      });
      const input = findChatInput();
      if (input) {
        let scope = input.parentElement;
        for (let i = 0; i < 5 && scope && scope !== document.body; i++) scope = scope.parentElement;
        scope = scope || document.body;
        scope.querySelectorAll('button, [role="button"], a, svg, i, span').forEach((el) => {
          if (info.clickablesNearInput.length >= 30) return;
          info.clickablesNearInput.push({
            tag: el.tagName,
            class: typeof el.className === 'string' ? el.className : String(el.className || ''),
            title: el.getAttribute('title'), aria: el.getAttribute('aria-label'),
            text: (el.textContent || '').trim().slice(0, 10),
            hasClickListener: hasClickListener(el),
          });
        });
      }
      const seenSrc = new Set();
      document.querySelectorAll('img').forEach((img) => {
        const s = img.getAttribute('src') || '';
        const dir = s.replace(/[^/]*$/, '');
        if (!seenSrc.has(dir) && s) {
          seenSrc.add(dir);
          if (info.imgSrcSamples.length < 20) info.imgSrcSamples.push(s.slice(0, 140));
        }
      });
      console.log('[Vaughn Emotes] DIAGNOSTICS:', JSON.stringify(info, null, 2));
      return info;
    } catch (err) {
      console.warn('[Vaughn Emotes] diagnostics failed:', err);
    }
  }
  try { window.__vaughnEmoteDiag = dumpEmojiDiagnostics; } catch (_) {}

  // ---------- emoji-picker toggle discovery ----------

  const EMOJI_GLYPH_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

  function emojiHintScore(el) {
    if (!el || el === chatInput) return 0;
    let score = 0;
    const cls = ((el.className && String(el.className)) || '').toLowerCase();
    const label = (
      (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || ''
    ).toLowerCase();
    const text = (el.textContent || '').trim().toLowerCase();
    if (/emoji|emote/.test(cls)) score += 3;
    else if (/smile|face|grin/.test(cls)) score += 2;
    if (/emoji|emote|smile|face/.test(label)) score += 3;
    if (EMOJI_GLYPH_RE.test(text) && text.length <= 4) score += 2;
    if (el.getAttribute && el.getAttribute('onclick')) score += 1;
    return score;
  }

  function hasClickListener(el) {
    // Recorded by our addEventListener hook (works for React root-delegated
    // handlers too? No — those live on document/root; we also accept any
    // element that is a plausible interactive control).
    return clickListenerTargets.has(el) || !!(el.getAttribute && el.getAttribute('onclick'));
  }

  function searchDocForEmojiButton(scope) {
    // `scope` may be a Document or an Element; normalize to a query root.
    const root = (scope && typeof scope.querySelectorAll === 'function')
      ? scope
      : document;
    const win = (root.defaultView) || window;
    const candidates = root.querySelectorAll(
      'button, [role="button"], a, span[class*="emoji"], div[class*="emoji"], i[class*="emoji"], svg[class*="emoji"], [class*="emoji_button"], [class*="emoji-btn"]'
    );
    let best = null, bestScore = 0;
    let fallback = null, fallbackScore = 0;
    for (const el of candidates) {
      let s = emojiHintScore(el);
      if (s === 0) {
        // No emoji hint, but our addEventListener hook proves it is clickable
        // and its class mentions chat/footer/input area -> weak candidate.
        if (hasClickListener(el)) {
          const cls = ((el.className && String(el.className)) || '').toLowerCase();
          if (/chat|footer|input|send/.test(cls)) {
            const fs = 1;
            if (fs > fallbackScore) { fallbackScore = fs; fallback = el; }
          }
        }
        continue;
      }
      if (hasClickListener(el)) s += 4;
      // Prefer small clickable controls near the bottom of the viewport
      // (chat footers), when layout info is available.
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > (win.innerHeight || 800) * 0.5) s += 1;
      } catch (_) {}
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best || fallback;
  }


  // ---- Cross-frame document registry -------------------------------------
  // With all_frames:true this script also runs inside the chat iframe and
  // registers itself with the top frame. We keep a list of every reachable
  // same-origin child document (recursively) so button search, harvesting
  // and diagnostics cover frames we cannot querySelector our way into.
  const foreignDocs = new Set();
  function registerForeignDoc(doc) {
    if (!doc || doc === document) return;
    try {
      doc.__vaughnEmoteScriptRan = true;
      foreignDocs.add(doc);
      hookDocument(doc);
    } catch (_) {}
  }
  function allReachableDocs() {
    const docs = [document];
    if (chatInput && chatInput.ownerDocument && !docs.includes(chatInput.ownerDocument)) {
      docs.push(chatInput.ownerDocument);
    }
    for (const d of foreignDocs) if (!docs.includes(d)) docs.push(d);
    // Depth-first scan of same-origin iframes from every known document.
    const queue = [...docs];
    while (queue.length) {
      const doc = queue.shift();
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (_) {}
      for (const f of frames) {
        let cd = null;
        try { cd = f.contentDocument; } catch (_) {}
        if (cd && cd.body && !docs.includes(cd)) {
          docs.push(cd);
          queue.push(cd);
          try { if (!cd.__vaughnEmoteScriptRan) registerForeignDoc(cd); } catch (_) {}
        }
      }
    }
    return docs;
  }

  function findEmojiButton() {
    // PRIORITY 1: the confirmed real toggle button, present in every frame's
    // DOM from page load (the <img class="vs_chatv9_input_emojis"> icon).
    // The old heuristic below sometimes matched a wrong emoji-ish element;
    // this exact selector makes that impossible.
    for (const doc of allReachableDocs()) {
      try {
        const exact = findEmojiToggleButton(doc);
        if (exact) return exact;
      } catch (_) {}
    }
    // Search EVERY reachable same-origin document: our own, the chat input's
    // owner document, any iframe that registered itself with us, and child
    // iframes we can walk into directly. A plain document.querySelector in
    // the top frame can never see a picker living in the chat iframe.
    for (const doc of allReachableDocs()) {
      let scope = doc.body;
      if (chatInput && doc === chatInput.ownerDocument) {
        scope = chatInput.closest('[class*="chat"], form, [class*="footer"], [class*="input"]') || doc.body;
      }
      const local = searchDocForEmojiButton(scope);
      if (local) return local;
      const globalBtn = searchDocForEmojiButton(doc);
      if (globalBtn) return globalBtn;
    }
    return null;
  }

  function fullClickSequence(el) {
    const doc = el.ownerDocument || document;
    const Win = (doc && doc.defaultView) || window;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 2, height: 2 };
    const x = rect.left + Math.max(rect.width / 2, 1);
    const y = rect.top + Math.max(rect.height / 2, 1);
    const base = { bubbles: true, cancelable: true, view: Win, clientX: x, clientY: y };
    try {
      if (typeof Win.PointerEvent === 'function') {
        el.dispatchEvent(new Win.PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
      }
      el.dispatchEvent(new Win.MouseEvent('mousedown', base));
      if (typeof Win.PointerEvent === 'function') {
        el.dispatchEvent(new Win.PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }));
      }
      el.dispatchEvent(new Win.MouseEvent('mouseup', base));
      el.dispatchEvent(new Win.MouseEvent('click', base));
    } catch (_) {
      // Ultimate fallback: native .click()
      try { el.click(); } catch (_) {}
    }
  }

  // React-style props discovery: for a rendered element, find its internal
  // instance key (__reactFiber$xxx / __reactInternalInstance$xxx), walk up
  // to the nearest host component and collect every string prop that looks
  // like an emoji name (short, no spaces). Used as a last-resort harvest
  // when neither class selectors nor title attributes match anything.
  function harvestFromReactFiber(maxItems) {
    const results = [];
    const seen = new Set();
    let rootsScanned = 0;
    const els = document.querySelectorAll('body *');
    for (const el of els) {
      if (results.length >= (maxItems || 400)) break;
      if (rootsScanned > 60) break; // don't scan the whole tree forever
      let fiberKey = null;
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) { fiberKey = k; break; }
      }
      if (!fiberKey) continue;
      rootsScanned++;
      let fiber = el[fiberKey];
      // walk up to a component with interesting props
      let hops = 0;
      while (fiber && hops < 12) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        if (props && typeof props === 'object') {
          for (const key of ['title', 'name', 'label', 'text', 'emoji', 'emote']) {
            const v = props[key];
            if (typeof v === 'string' && v.length > 0 && v.length <= 32 && !/\s/.test(v)) {
              const name = parseEmoteName(v);
              if (name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                results.push({ id: '', name, filename: '', width: 60, height: 60 });
              }
            }
          }
          // arrays of emote objects: [{id, name/title}, ...]
          for (const val of Object.values(props)) {
            if (Array.isArray(val) && val.length >= 5 && val.every(x => x && typeof x === 'object')) {
              for (const obj of val) {
                const nm = obj.name || obj.title || obj.label;
                if (typeof nm === 'string' && nm.length && nm.length <= 32) {
                  const name = parseEmoteName(nm);
                  if (name && !seen.has(name.toLowerCase())) {
                    seen.add(name.toLowerCase());
                    results.push({ id: String(obj.id || ''), name, filename: '', width: 60, height: 60 });
                  }
                }
              }
            }
          }
        }
        fiber = fiber.return;
        hops++;
      }
    }
    return results;
  }

  // Wait until either emotes appear in the DOM, or timeout.
  function waitForDomEmotes(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        const list = parseEmotesFromDOM();
        if (list.length > 0 || Date.now() - start > timeoutMs) { resolve(list); return; }
        setTimeout(poll, 150);
      };
      poll();
    });
  }

  // ---- Site API toggle: vs_chatv9.toggleEmojisBox() -----------------------
  // The site exposes a global object/function that opens/closes the emoji
  // picker. CRITICAL: Firefox content scripts run in an ISOLATED WORLD —
  // they share the DOM with the page but NOT its JavaScript globals. That's
  // exactly why typing `vs_chatv9.toggleEmojisBox()` in DevTools (which runs
  // in the PAGE world) works, while our earlier `Win.vs_chatv9` check always
  // failed ("not reachable"). The fix is a real page-world script:
  //   1. We write a small loader file (page_api_loader.js) at build/install
  //      time via browser.runtime.getURL + a blob-free <script src> tag —
  //      Firefox allows web-accessible resources this way even under the
  //      site's CSP for extension-origin URLs... but vaughn.live's CSP may
  //      block inline AND external scripts, so we ALSO try
  //      "world": "MAIN" execution via scripting.executeScript (MV3) or,
  //      since this manifest is MV2, the classic technique below.
  //   2. Classic MV2 technique that survives most CSPs: dispatching a
  //      CustomEvent FROM the page world requires code in the page world,
  //      so instead we hook the *DOM*: the page's own toggle button
  //      (`img.vs_chatv9_input_emojis`) has a real click listener attached
  //      by the site. A synthetic full-pointer click sequence on THAT exact
  //      element invokes the site's own handler, which calls
  //      vs_chatv9.toggleEmojisBox() internally. This is equivalent to the
  //      user clicking it, and unlike our old heuristic it never targets a
  //      wrong element because we select it by its actual class/src.
  //   3. As a bonus, we also attempt a direct page-world call via a
  //      dynamically inserted <script> (works when the site has no strict
  //      CSP) and remember success so future toggles skip the click path.
  let toggleOpenState = false; // only tracked when we drive it via the API
  let pageWorldCallOk = false; // direct window-vs_chatv9 call worked once
  let cspBlockedInline = false;

  // The REAL emoji toggle button, per the user-confirmed markup:
  //   <img src="//cdn.vaughnsoft.net/img/svg/emoji.svg" class="vs_chatv9_input_emojis">
  function findEmojiToggleButton(doc) {
    const selectors = [
      'img.vs_chatv9_input_emojis',                       // confirmed class
      'img[src*="/img/svg/emoji.svg"]',                   // confirmed src
      '.vs_chatv9_input_emojis',                          // wrapper div/li
      '[class*="vs_chatv9"][class*="emojis"]',            // any chat emojis el
    ];
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  // Try to call the site function directly from the PAGE world by injecting
  // a script tag. Returns a promise resolving true/false. Safe to fail.
  function tryPageWorldCall(doc) {
    return new Promise((resolve) => {
      if (cspBlockedInline) { resolve(false); return; }
      try {
        const Win = doc.defaultView;
        if (!Win) { resolve(false); return; }
        const RESULT_EVT = 'vaughn-emote-api-result';
        const REQ_EVT = 'vaughn-emote-api-request';
        let settled = false;
        const onResult = (e) => {
          // Only trust results coming from the page world (our isolated
          // listener sees events dispatched by injected page scripts too).
          settled = true;
          resolve(!!(e && e.detail && e.detail.ok));
        };
        Win.addEventListener(RESULT_EVT, onResult, { once: true });
        const s = doc.createElement('script');
        s.onload = () => {};
        s.onerror = () => { cspBlockedInline = true; };
        // NOTE: the whole body is built with array-join so we never have to
        // juggle nested quote escaping (a previous version produced invalid
        // JS here, which silently broke the page-world bridge).
        s.textContent = [
          '(function(){',
          '  var respond=function(ok){',
          '    try{ window.dispatchEvent(new CustomEvent("' + RESULT_EVT + '", {detail:{ok:ok}})); }catch(e){}',
          '  };',
          '  document.addEventListener("' + REQ_EVT + '", function(){',
          '    var ok=false;',
          '    try{ if(window.vs_chatv9 && typeof window.vs_chatv9.toggleEmojisBox==="function"){ window.vs_chatv9.toggleEmojisBox(); ok=true; } }catch(e){}',
          '    respond(ok);',
          '  }, false);',
          // Fire a result for the request that was dispatched while this
          // script was still parsing (jsdom/CSP timing safety).
          '  if(window.__vaughnEmotePendingRequest){ window.__vaughnEmotePendingRequest=false;',
          '    var ok2=false;',
          '    try{ if(window.vs_chatv9 && typeof window.vs_chatv9.toggleEmojisBox==="function"){ window.vs_chatv9.toggleEmojisBox(); ok2=true; } }catch(e){}',
          '    respond(ok2);',
          '  }',
          '})();',
        ].join('\n');
        (doc.body || doc.documentElement).appendChild(s);
        s.remove();
        // Ask the injected page-world listener to perform the toggle. The
        // flag lets a late-parsing page script catch the request anyway.
        try { Win.__vaughnEmotePendingRequest = true; } catch (_) {}
        Win.dispatchEvent(new Win.Event(REQ_EVT));
        setTimeout(() => {
          if (!settled) {
            Win.removeEventListener(RESULT_EVT, onResult);
            // No response => inline script was blocked (CSP) or silent.
            cspBlockedInline = true;
            resolve(false);
          }
        }, 400);
      } catch (_) {
        cspBlockedInline = true;
        resolve(false);
      }
    });
  }

  // Is the picker currently rendered/open in any reachable document?
  function pickerIsOpen() {
    for (const d of allReachableDocs()) {
      try {
        if (d.querySelector('.vs_chatv9_emoji_item, [class*="emoji_item"]')) return true;
      } catch (_) {}
    }
    return false;
  }

  // Call vs_chatv9.toggleEmojisBox() ONLY when that will OPEN the picker.
  // Returns: 'opened' | 'closed' | 'noop'. The old code toggled blindly, so
  // depending on the picker's current state the same call could close it
  // immediately after opening — a plausible reason your manual console call
  // worked while ours appeared not to.
  async function ensurePickerOpened(doc) {
    const Win = doc && doc.defaultView;
    if (!Win) return 'noop';
    const wasOpen = pickerIsOpen();
    let method = null;
    // Path A: Firefox-only privileged access to the page's JS objects.
    try {
      if (Win.wrappedJSObject && Win.wrappedJSObject.vs_chatv9 &&
          typeof Win.wrappedJSObject.vs_chatv9.toggleEmojisBox === 'function') {
        Win.wrappedJSObject.vs_chatv9.toggleEmojisBox();
        method = 'wrappedJSObject';
      }
    } catch (_) {}
    // Path B: inject a tiny script into the PAGE world and ask it to call
    // the function (works whenever the site's CSP allows inline scripts).
    if (!method && (pageWorldCallOk || !cspBlockedInline)) {
      const ok = await tryPageWorldCall(doc);
      if (ok) { pageWorldCallOk = true; method = 'page-world-script'; }
    }
    // Path C: click the confirmed real toggle <img class="vs_chatv9_input_emojis">.
    if (!method) {
      const btn = findEmojiToggleButton(doc);
      if (btn) { fullClickSequence(btn); method = 'toggle-img-click'; }
    }
    if (!method) return 'noop';
    // Wait a moment for lazy render, then verify the picker actually opened.
    const opened = await new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        if (pickerIsOpen()) { resolve(true); return; }
        if (Date.now() - start > 1500) { resolve(false); return; }
        setTimeout(poll, 100);
      };
      poll();
    });
    console.log(`[Vaughn Emotes] Toggle via ${method}: wasOpen=${wasOpen} -> nowOpen=${opened}`);
    if (opened) return 'opened';
    if (wasOpen) return 'closed';   // we accidentally closed it — retry once
    return 'noop';
  }

  async function callSiteToggle(doc) {
    const r = await ensurePickerOpened(doc);
    return r !== 'noop';
  }

  // Find whichever document currently shows rendered emote items.
  function docWithEmoteItems() {
    for (const doc of allReachableDocs()) {
      try {
        if (parseEmotesFromDOM(doc).length > 0 || parseEmotesGenericFromDOM(doc).length > 0) {
          return doc;
        }
      } catch (_) {}
    }
    return null;
  }

  // Open the picker via the site's own API, harvest, then close it again.
  // Returns true if a toggle path was available and used (regardless of
  // whether new emotes appeared), false if nothing is reachable at all.
  async function virtualLoadViaSiteApi() {
    // Prefer the chat input's document, then our own, then any reachable frame.
    const candidates = [];
    if (chatInput && chatInput.ownerDocument) candidates.push(chatInput.ownerDocument);
    candidates.push(document);
    for (const d of allReachableDocs()) if (!candidates.includes(d)) candidates.push(d);

    let result = 'noop';
    let usedDoc = null;
    for (const doc of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const r = await ensurePickerOpened(doc);
      if (r === 'opened') { result = 'opened'; usedDoc = doc; break; }
      if (r !== 'noop' && result === 'noop') { result = r; usedDoc = doc; }
    }
    // If the first attempt CLOSED the picker (it was already open), try once
    // more — the second call re-opens it.
    if (result === 'closed') {
      for (const doc of candidates) {
        // eslint-disable-next-line no-await-in-loop
        const r = await ensurePickerOpened(doc);
        if (r === 'opened') { result = 'opened'; usedDoc = doc; break; }
      }
    }
    if (result === 'noop') return false;

    const openedNow = result === 'opened';

    // Poll up to 4s for lazy-rendered items in ANY frame.
    const list = await (() => {
      return new Promise((resolve) => {
        const start = Date.now();
        const poll = () => {
          for (const doc of allReachableDocs()) {
            let l = [];
            try { l = parseEmotesFromDOM(doc); } catch (_) {}
            if (l.length === 0) { try { l = parseEmotesGenericFromDOM(doc); } catch (_) {} }
            if (l.length > 0) { resolve(l); return; }
          }
          if (Date.now() - start > 4000) { resolve([]); return; }
          setTimeout(poll, 150);
        };
        poll();
      });
    })();

    if (list.length > 0) {
      pickerEverOpened = true;
      const before = emotes.size;
      storeEmotes(list);
      console.log(`[Vaughn Emotes] Picker rendered ${list.length} items; total now ${emotes.size} (+${emotes.size - before}).`);
      maybeBuildDropdown();
      if (!isTopFrame() && emotes.size >= MIN_FULL_LIST) postEmotesToParent(Array.from(emotes.values()));
    } else {
      console.warn('[Vaughn Emotes] Toggle used but no emote items rendered.');
    }

    // Close the picker again ONLY if we are the ones who opened it.
    if (openedNow && usedDoc) {
      try {
        const btn = findEmojiToggleButton(usedDoc) || findEmojiButton();
        if (btn && pickerIsOpen()) fullClickSequence(btn);
      } catch (_) {}
    }
    return true;
  }

  // THE MAIN LOADER: virtually open the emoji picker, harvest items, close it.
  async function virtualLoadEmotesByClickingPicker() {
    if (emotes.size >= MIN_FULL_LIST) return;
    if (virtualClickAttempts >= VIRTUAL_CLICK_MAX_ATTEMPTS) {
      console.warn('[Vaughn Emotes] Gave up after ' + virtualClickAttempts + ' virtual picker attempts. Current total: ' + emotes.size + '.');
      return;
    }
    virtualClickAttempts += 1;
    lastVirtualClickAt = Date.now();

    tryInitInput();

    // PREFERRED PATH: the site's own API, vs_chatv9.toggleEmojisBox().
    // This reliably opens the *real* picker regardless of which element the
    // heuristic button search would have (mis)targeted.
    const apiUsed = await virtualLoadViaSiteApi();
    if (apiUsed) {
      if (emotes.size < MIN_FULL_LIST) {
        scheduleVirtualEmoteLoad(3000);
      } else {
        console.log(`[Vaughn Emotes] Full emote list loaded: ${emotes.size} emotes.`);
      }
      return;
    }
    console.warn('[Vaughn Emotes] vs_chatv9.toggleEmojisBox() not reachable; falling back to synthetic click.');

    const btn = findEmojiButton();
    if (!btn) {
      console.warn(`[Vaughn Emotes] Virtual load attempt ${virtualClickAttempts}: emoji picker button not found yet.`);
      scheduleVirtualEmoteLoad(3000);
      return;
    }
    console.log('[Vaughn Emotes] Virtual click target:', btn.tagName, btn.className || '(no class)',
                '| listener:', hasClickListener(btn) ? 'yes' : 'NO');

    const hadFocus = document.activeElement;

    // Snapshot every element currently in the body. After the click we only
    // consider elements that were NOT present before — i.e. newly rendered.
    const beforeNodes = new WeakSet();
    document.querySelectorAll('body *').forEach((el) => beforeNodes.add(el));
    const hiddenForHarvest = [];
    const suppressNewPopups = () => {
      document.querySelectorAll('body *').forEach((el) => {
        if (beforeNodes.has(el) || hiddenForHarvest.includes(el)) return;
        const cs = getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'absolute') &&
            el.offsetHeight > 40 && el.offsetWidth > 40) {
          el.style.setProperty('visibility', 'hidden', 'important');
          hiddenForHarvest.push(el);
        }
      });
    };

    // The picker may render into a DIFFERENT document than ours (chat inside
    // a same-origin iframe). Scan all reachable documents for emote items.
    const harvestAllDocs = () => {
      for (const doc of allReachableDocs()) {
        const list = parseEmotesFromDOM(doc);
        if (list.length > 0) return list;
      }
      return [];
    };

    let harvestTimer = null;
    try {
      fullClickSequence(btn);
      harvestTimer = setInterval(suppressNewPopups, 50);
      suppressNewPopups();

      // Poll up to 4s waiting for lazy-rendered emote items in ANY frame.
      const list = await (() => {
        return new Promise((resolve) => {
          const start = Date.now();
          const poll = () => {
            const l = harvestAllDocs();
            if (l.length > 0 || Date.now() - start > 4000) { resolve(l); return; }
            setTimeout(poll, 150);
          };
          poll();
        });
      })();
      if (list.length > 0) {
        pickerEverOpened = true;
        const before = emotes.size;
        storeEmotes(list);
        console.log(`[Vaughn Emotes] Virtual click rendered ${list.length} items; total now ${emotes.size} (+${emotes.size - before}).`);
        maybeBuildDropdown();
        if (!isTopFrame() && emotes.size >= MIN_FULL_LIST) postEmotesToParent(Array.from(emotes.values()));
      } else {
        console.warn(
          `[Vaughn Emotes] Virtual picker click (attempt ${virtualClickAttempts}/${VIRTUAL_CLICK_MAX_ATTEMPTS}) rendered no NEW emote items (total still ${emotes.size}).`
        );
        dumpEmojiDiagnostics();
        // Tell the parent frame we tried and found nothing, so a top-frame
        // instance stuck on 0 can stop guessing and log a useful message.
        if (!isTopFrame()) postEmotesToParent([]);
      }
    } finally {
      if (harvestTimer) clearInterval(harvestTimer);
      hiddenForHarvest.forEach((el) => el.style.removeProperty('visibility'));
      // Close the picker again: Escape, then toggle-click if still open.
      const doc2 = btn.ownerDocument || document;
      try {
        (doc2.activeElement || doc2.body).dispatchEvent(
          new ((doc2.defaultView || window).KeyboardEvent)('keydown', { key: 'Escape', bubbles: true })
        );
      } catch (_) {}
      if (harvestAllDocs().length > 0) fullClickSequence(btn);
      if (hadFocus && typeof hadFocus.focus === 'function') hadFocus.focus({ preventScroll: true });
    }

    // Keep going until we have what looks like the FULL list. If the count
    // is stuck, the picker likely lazy-renders on scroll — try scrolling it
    // open before the next click.
    if (emotes.size < MIN_FULL_LIST) {
      scheduleVirtualEmoteLoad(3000);
    } else {
      console.log(`[Vaughn Emotes] Full emote list loaded: ${emotes.size} emotes.`);
    }
  }

  // Scroll every visible emoji-picker container to force lazy-render of all
  // items (virtualized pickers only mount what's in view).
  function scrollPickerContainers() {
    for (const doc of allReachableDocs()) {
      let nodes = [];
      try { nodes = Array.from(doc.querySelectorAll('[class*="emoji"], [class*="emote"]')); } catch (_) {}
      for (const el of nodes) {
        try {
          if (el.scrollHeight > el.clientHeight + 20) {
            const step = Math.max(el.clientHeight, 200);
            el.scrollTop = 0;
            el.dispatchEvent(new (doc.defaultView || window).Event('scroll', { bubbles: true }));
            let y = 0;
            const tick = () => {
              y += step;
              el.scrollTop = y;
              el.dispatchEvent(new (doc.defaultView || window).Event('scroll', { bubbles: true }));
              if (y < el.scrollHeight) setTimeout(tick, 60);
              else { el.scrollTop = 0; }
            };
            tick();
          }
        } catch (_) {}
      }
    }
  }

  // Candidate selectors, most specific first. Vaughn's CSS classes carry a
  // version suffix (vs_chatv9_*), which changes over time — prefix/substring
  // selectors survive those renames, exact ones don't.
  const EMOTE_ITEM_SELECTORS = [
    '.vs_chatv9_emoji_item',
    '[class*="emoji_item"]',
    '[class*="emoji"][class*="item"]',
    '[class*="emote"]',
  ];

  // Last-resort generic parser: if the picker DID render but none of our
  // class selectors matched its items, harvest clickable elements that
  // contain an <img> and have a title — whatever their class is. This is
  // how virtually every emoji picker is structured, so it survives site
  // CSS renames (vs_chatv9_* -> vs_chatv10_* etc.).
  // Does this element (or an ancestor) look like the emoji PICKER container,
  // as opposed to a chat message area? Used by every DOM heuristic so menu
  // items are kept and message-list badges are dropped.
  function isPickerish(el) {
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      const hay = (((cur.className && String(cur.className)) || '') + ' ' + (cur.id || '')).toLowerCase();
      if (/emoji|emote/.test(hay)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function parseEmotesGenericFromDOM(doc) {
    doc = doc || document;
    const candidates = doc.querySelectorAll(
      '[title] img, [title] > img, button img, [role="button"] img, li img, span[class] img, div[class] img'
    );
    // Precompute the chat container so we can tell "emote-ish imgs inside
    // the chat" (streamer badges, sub emotes shown in messages) apart from
    // actual picker items. Without this, a chat full of badge imgs yields a
    // bogus 15-item "list" and masks the real ~1600-emote picker.
    let chatScope = null;
    try {
      const inp = findChatInputInDoc(doc);
      if (inp) {
        // Climb until we reach an element that also contains other images
        // (i.e. covers the message list, not just the footer/input).
        chatScope = inp.closest('[class*="chat"], form') || inp.parentElement;
        for (let i = 0; i < 8 && chatScope && chatScope.parentElement && chatScope.parentElement !== doc.body; i++) {
          if (chatScope.querySelectorAll('img').length >= 5) break;
          chatScope = chatScope.parentElement;
        }
      }
    } catch (_) {}
    // The whole-page container can never be a "message area" — pruning
    // against body/html would disable the badge filter entirely (this was a
    // bug: chat badge imgs got harvested as "emotes" on real pages where
    // the closest [class*=chat] ancestor IS the body-level wrapper).
    if (chatScope && (chatScope === doc.body || chatScope === doc.documentElement)) {
      chatScope = null;
    }
    // Identify the toggle button up front: its subtree (the emoji menu,
    // whether it renders inline next to the button or as a popup appended
    // under it) is NEVER a message area — exclude it from chatScope pruning.
    let toggleBtn = null;
    try { toggleBtn = searchDocForEmojiButton(doc === document ? doc : (doc.body || doc)); } catch (_) {}
    const results = [];
    const seen = new Set();
    candidates.forEach((img) => {
      // Walk up to the nearest ancestor that has a title or onclick.
      let holder = img.closest('[title], [onclick]');
      if (!holder) return;
      const title = parseEmoteName(holder.getAttribute('title') || '');
      if (!title) return;
      // Skip UI chrome icons (small non-emote images, avatars, etc.):
      // real emote imgs are usually 20-80px and served from one dir.
      const src = img.getAttribute('src') || '';
      if (!src || /\.(svg|gif)($|\?)/i.test(src) && /logo|icon|flag/i.test(src)) return;
      // Inside the chat area but NOT clickable -> it's a badge/emote shown
      // in a message, not a picker item. Ignore it. (Exception: anything
      // under the emoji toggle button is the menu itself, keep it.)
      const clickable = !!(holder.getAttribute('onclick') || clickListenerTargets.has(holder));
      const inToggleSubtree = toggleBtn && (toggleBtn === holder || toggleBtn.contains(holder));
      if (!clickable && !inToggleSubtree && chatScope && chatScope.contains(holder)) return;
      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const onclick = holder.getAttribute('onclick') || String(holder.onclick || '');
      const idMatch = onclick.match(/insertEmoji\(\s*['"]([^'"]+)['"]\s*,/);
      results.push({
        id: idMatch ? idMatch[1] : '',
        name: title,
        filename: src.split('/').pop(),
        width: parseInt(img.getAttribute('width'), 10) || img.naturalWidth || 0,
        height: parseInt(img.getAttribute('height'), 10) || img.naturalHeight || 0,
      });
    });
    // Require a plausible count before trusting this heuristic (a chat page
    // has a handful of titled imgs outside the picker too).
    if (results.length >= 5) {
      console.log(`[Vaughn Emotes] Generic DOM parse: ${results.length} emotes (no class match needed)`);
      return results;
    }
    return [];
  }

  function parseEmotesFromDOM(doc) {
    doc = doc || document;
    let best = [];
    for (const sel of EMOTE_ITEM_SELECTORS) {
      const items = doc.querySelectorAll(sel);
      if (items.length === 0) continue;
      const parsed = extractEmotes(items);
      // Don't return the FIRST selector that matches: broad selectors like
      // '[class*="emote"]' also match the picker *container* divs, and a
      // container's <img title> is often just the toggle icon — returning
      // early harvested 15 chat badges instead of the real ~1600 items.
      // Collect all candidates and keep the largest, most specific result.
      if (parsed.length > best.length) best = parsed;
    }
    if (best.length > 0) {
      console.log(`[Vaughn Emotes] DOM parse: ${best.length} emotes via class selectors`);
      return best;
    }
    const generic = parseEmotesGenericFromDOM(doc);
    if (generic.length > 0) return generic;
    // Final resort: React fiber props (survives any CSS rename / missing titles).
    const fiber = harvestFromReactFiber();
    if (fiber.length >= 5) {
      console.log(`[Vaughn Emotes] React fiber harvest: ${fiber.length} emotes`);
      return fiber;
    }
    return [];
  }

  // Parse the page HTML WITHOUT relying on any class name at all:
  // find every insertEmoji(...) call site, then walk the tag backwards
  // to pick up its title="..." / data-title="..." attributes.
  function parseEmotesFromHtmlString(html) {
    const results = [];
    const seen = new Set();
    const callRe = /insertEmoji\(\s*(?:&#0?39;|&apos;|'|")([^'"&]+)(?:&#0?39;|&apos;|'|")\s*,/g;
    let m;
    while ((m = callRe.exec(html)) !== null) {
      const id = m[1];
      // Find the start of the <tag ...> that contains this onclick
      const tagStart = html.lastIndexOf('<', m.index);
      if (tagStart === -1) continue;
      const tagStr = html.slice(tagStart, m.index + m[0].length + 200);
      const titleMatch =
        tagStr.match(/title=(?:&#0?39;|&apos;|'|")([^'"&]*)/) ||
        tagStr.match(/data-(?:emote-)?title=(?:&#0?39;|&apos;|'|")([^'"&]*)/);
      if (!titleMatch) continue;
      const name = parseEmoteName(titleMatch[1]);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      results.push({ id, name, filename: '', width: 60, height: 60 });
    }
    return results;
  }

  // The initial page HTML never contains the picker items (lazy render), so
  // instead of fetching the page we look for the site's own emote-list JSON.
  // Sites like this usually load the emoji list from a static endpoint
  // (e.g. /emotes.json, /chat/emojis, cdn.../emoji*.json). We discover the
  // URL by scanning every <script src>, performance entries and links for a
  // plausible name, then fetch it same-origin and extract names+ids with a
  // tolerant regex over the raw text (works whether it's JSON or JS).
  const EMOTE_URL_RE = /(emote|emoji|smiley)[^/]*\.(json|js)(\?|$)/i;

  function candidateEmoteUrls() {
    const urls = new Set();
    const add = (u) => { try { urls.add(new URL(u, location.href).href); } catch (_) {} };
    try {
      document.querySelectorAll('script[src]').forEach((s) => {
        const src = s.src || '';
        if (EMOTE_URL_RE.test(src)) add(src);
      });
      document.querySelectorAll('link[href]').forEach((l) => {
        if (EMOTE_URL_RE.test(l.href)) add(l.href);
      });
    } catch (_) {}
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (EMOTE_URL_RE.test(e.name)) add(e.name);
      }
    } catch (_) {}
    // Common guesses as last resort.
    ['/', '/chat', '/emotes', '/emoji'].forEach(() => {}); // no-op keep shape
    return Array.from(urls);
  }

  // Extract {id,name} pairs from arbitrary JSON/JS text without assuming a
  // schema: any object that has BOTH some id-ish field and some name/title
  // -ish string field is treated as an emote.
  function extractEmotesFromJsonText(text) {
    const results = [];
    const seen = new Set();
    const objRe = /\{[^{}]*\}/g;   // flat objects only (emote lists are flat)
    let m;
    while ((m = objRe.exec(text)) !== null) {
      const chunk = m[0];
      const idM = chunk.match(/["']?(?:id|emoji_?id|emote_?id)["']?\s*[:=]\s*["']?([\w-]{3,64})["']?/i);
      const nameM =
        chunk.match(/["']?(?:name|title|label|shortcode|code)["']?\s*[:=]\s*["']([^"']{1,48})["']/i);
      if (!nameM) continue;
      const name = parseEmoteName(nameM[1]);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      results.push({ id: idM ? idM[1] : '', name, filename: '', width: 60, height: 60 });
    }
    return results;
  }

  async function fetchEmotesJSON() {
    const urls = candidateEmoteUrls();
    for (const url of urls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(url, { credentials: 'same-origin', cache: 'default' });
        if (!res.ok) continue;
        // eslint-disable-next-line no-await-in-loop
        const text = await res.text();
        const results = extractEmotesFromJsonText(text);
        if (results.length >= 20) {
          console.log(`[Vaughn Emotes] JSON source ${url}: ${results.length} emotes`);
          return results;
        }
      } catch (_) {}
    }
    return [];
  }

  async function fetchEmotesHTML() {
    try {
      const res = await fetch(window.location.origin + window.location.pathname, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const results = parseEmotesFromHtmlString(html);
      if (results.length === 0) {
        console.warn(
          '[Vaughn Emotes] fetch fallback found no insertEmoji() calls in HTML.',
          'If you see this in the WEB CONSOLE (not the add-on console), Cloudflare blocked the request.'
        );
      } else {
        console.log(`[Vaughn Emotes] HTML fallback: ${results.length} emotes`);
      }
      return results;
    } catch (err) {
      console.warn('[Vaughn Emotes] fetch fallback failed:', err);
      return [];
    }
  }

  function storeEmotes(list) {
    for (const e of list) {
      emotes.set(e.name.toLowerCase(), e);
    }
  }

  // Re-parse the picker from the DOM WITHOUT logging (called on every user
  // open via a MutationObserver). Picker items usually carry an onclick
  // attribute or were recorded by our click-listener hook — require that so
  // chat-message badge imgs are never mistaken for picker items.
  function silentDomParse() {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll('[title] img')); } catch (_) {}
    const results = [];
    const seen = new Set();
    for (const img of nodes) {
      const holder = img.closest('[title], [onclick]');
      if (!holder) continue;
      const title = parseEmoteName(holder.getAttribute('title') || '');
      if (!title) continue;
      const clickable = !!(holder.getAttribute('onclick') || clickListenerTargets.has(holder));
      if (!clickable) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const src = img.getAttribute('src') || '';
      results.push({ id: '', name: title, filename: src.split('/').pop(), width: 0, height: 0 });
    }
    return results;
  }

  // Keep the local store in sync when the USER opens the emoji menu: any
  // subtree mutation inside a container whose class mentions emoji/emote is
  // treated as "picker rendered/changed" -> merge silently into the store.
  let pickerObservers = new WeakSet();
  function startLiveMerge(doc) {
    if (!doc || !doc.body || pickerObservers.has(doc)) return;
    try {
      const obs = new doc.defaultView.MutationObserver((muts) => {
        for (const m of muts) {
          const el = m.target && m.target.nodeType === 1 ? m.target : (m.target && m.target.parentElement);
          const hay = (((el && el.className) || '') + ' ' + ((el && el.id) || '')).toLowerCase();
          if (/emoji|emote/.test(hay)) {
            const list = silentDomParse();
            if (list.length > 0) {
              const before = emotes.size;
              storeEmotes(list);
              if (emotes.size !== before) {
                console.log(`[Vaughn Emotes] Live merge: +${emotes.size - before} emotes (total ${emotes.size}).`);
              }
            }
            break;
          }
        }
      });
      obs.observe(doc.body, { childList: true, subtree: true });
      pickerObservers.add(doc);
    } catch (_) {}
  }

  let loadedFromHtml = false;

  async function loadEmotes() {
    // The emoji list is rendered lazily (only when the picker is opened),
    // so a plain DOM query at page-load will find nothing. Try anyway —
    // maybe the user already opened it or the site pre-renders it.
    let list = parseEmotesFromDOM();
    if (list.length === 0 && !loadedFromHtml) {
      // Fallback 1: the site's own emote-list JSON/JS bundle (discovered via
      // resource timing + script srcs). This is the ONLY way to get the full
      // ~1600-emote list without opening the picker.
      list = await fetchEmotesJSON();
    }
    if (list.length === 0 && !loadedFromHtml) {
      // Fallback 2: some servers do include the picker markup in the HTML.
      list = await fetchEmotesHTML();
      if (list.length > 0) loadedFromHtml = true;
    }
    storeEmotes(list);
    console.log(`[Vaughn Emotes] Loaded ${emotes.size} emotes${emotes.size > 0 && emotes.size < MIN_FULL_LIST ? ' (partial — continuing to load the full picker list…)' : ''}`);
    if (emotes.size >= MIN_FULL_LIST) maybeBuildDropdown();

    if (!isTopFrame()) {
      // Child frame: share whatever we have (even empty) with the parent.
      postEmotesToParent(Array.from(emotes.values()));
    }

    if (emotes.size < MIN_FULL_LIST) {
      // Nothing yet (or only a small pre-rendered subset, e.g. "recently
      // used" badges) -> virtually open the emoji picker to force-render
      // the full list and keep merging until it looks complete.
      scheduleVirtualEmoteLoad();
    }
  }

  // ---------- autocomplete UI ----------

  function getQuery() {
    if (!chatInput) return null;
    const pos = chatInput.selectionStart;
    // selectionStart can be null on some input types (email/number) or in
    // odd browser states — fall back to end-of-value instead of throwing.
    if (pos === null || pos === undefined) return null;
    const textUpToCursor = chatInput.value.slice(0, pos);
    // IMPORTANT: only the text BEFORE the cursor is ever considered. The
    // chat box is a <textarea> whose Enter key inserts "\n" (submitChat
    // handles sending), so `value` can contain multiline history — anything
    // after the cursor must never influence the query.
    // Single backward scan finds the NEAREST trigger char before the cursor.
    // The old per-trigger loop aborted with `return null` as soon as the
    // ':' scan crossed a '!' (and vice-versa), so e.g. "!po" could return
    // null depending on TRIGGER_CHARS order — one of the reasons the
    // dropdown never appeared while typing.
    let idx = -1;
    let trigger = null;
    for (let i = pos - 1; i >= 0; i--) {
      const ch = textUpToCursor[i];
      if (/\s/.test(ch)) break;              // start of current word
      if (TRIGGER_CHARS.includes(ch)) {
        idx = i;                             // nearest trigger char before cursor
        trigger = ch;
        break;                               // everything between it and the
      }                                      // cursor is the live query
    }
    if (idx !== -1 && trigger) {
      const query = textUpToCursor.slice(idx + 1);
      // e.g. ":smile:" with cursor right after the closing colon -> the
      // nearest trigger IS the closing colon and query is empty; show the
      // full list only when there is at least one char to filter by, and
      // hide otherwise (handled by caller via MIN_QUERY_LEN).
      if (/^\S*$/.test(query)) {
        return { trigger, index: idx, query };
      }
    }
    return null;
  }

  function matchEmotes(query) {
    if (!query || query.length < MIN_QUERY_LEN) return [];
    const q = query.toLowerCase();
    const starts = [];
    const contains = [];
    for (const e of emotes.values()) {
      const name = e.name.toLowerCase();
      if (name.startsWith(q)) starts.push(e);
      else if (name.includes(q)) contains.push(e);
    }
    return starts.concat(contains).slice(0, MAX_SUGGESTIONS);
  }

  function positionDropdown() {
    if (!dropdown || !chatInput) return;
    // The dropdown lives in OUR document, but chatInput may live in an
    // iframe. Convert the input's viewport-relative rect to coordinates in
    // our own viewport by adding the containing frame's offset chain.
    let rect;
    try { rect = chatInput.getBoundingClientRect(); } catch (_) { return; }
    let left = rect.left;
    let top = rect.top;
    let win = window;
    try {
      const ownerWin = chatInput.ownerDocument && chatInput.ownerDocument.defaultView;
      while (ownerWin && win !== ownerWin) {
        const frameEl = win.frameElement;
        if (!frameEl) break;
        const fr = frameEl.getBoundingClientRect();
        left += fr.left;
        top += fr.top;
        win = win.parent;
      }
    } catch (_) {}
    const vh = window.innerHeight || 800;
    dropdown.style.left = `${Math.max(0, left)}px`;
    dropdown.style.bottom = `${Math.max(0, vh - top + 4)}px`;
    dropdown.style.width = `${Math.max(rect.width, 220)}px`;
  }

  function renderDropdown(matches) {
    dropdown.innerHTML = '';
    matches.forEach((emote, i) => {
      const item = document.createElement('div');
      item.className = 'vaughn-emote-item' + (i === activeIndex ? ' vaughn-emote-active' : '');
      item.textContent = emote.name;
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault(); // keep focus in the chat input
        selectEmote(emote);
      });
      dropdown.appendChild(item);
    });
  }

  function showAutocomplete() {
    if (!chatInput) return;
    // IMPORTANT: previously this bailed out when `dropdown` was null. In the
    // real page the input is only discovered at load, but buildUI could be
    // skipped by any earlier exception -> dropdown stayed null forever and
    // the popup NEVER appeared. Create it on demand instead.
    if (!dropdown || !(chatInput.ownerDocument || document).contains(dropdown)) buildUI();
    if (!dropdown) return;
    const q = getQuery();
    if (!q || !q.query) return hideAutocomplete();   // need at least ":x" — ":" alone shows nothing
    currentMatches = matchEmotes(q.query);
    if (currentMatches.length === 0) return hideAutocomplete();
    activeIndex = 0;
    renderDropdown(currentMatches);
    positionDropdown();
    dropdown.style.display = 'block';
    // Self-check: if the site's own code wiped our popup (e.g. a global
    // innerHTML rewrite), re-attach it once so we can tell the difference
    // between "never shown" and "shown then removed".
    setTimeout(() => {
      try {
        const ddoc = (chatInput && chatInput.ownerDocument) || document;
        if (dropdown && !ddoc.contains(dropdown)) {
          console.warn('[Vaughn Emotes] Dropdown was REMOVED from the DOM shortly after being shown — the site wipes our node.');
          (ddoc.body || ddoc.documentElement).appendChild(dropdown);
        } else if (dropdown && dropdown.parentElement && dropdown.style.display === 'block') {
          console.log('[Vaughn Emotes] Dropdown is in the DOM and visible (items:', dropdown.children.length + ').');
        }
      } catch (_) {}
    }, 50);
  }

  function hideAutocomplete() {
    if (dropdown) dropdown.style.display = 'none';
    activeIndex = -1;
    currentMatches = [];
  }

  // Insert the chosen emote, replacing the ":partial" text at the cursor.
  function selectEmote(emote) {
    if (!chatInput) return;
    const q = getQuery();
    const pos = chatInput.selectionStart;
    const start = q ? q.index : pos;
    // Preserve whichever trigger the user typed: ':foo' inserts ':name: ',
    // '!foo' inserts 'name: ' (vaughn-style emote codes). The old code always
    // inserted a leading colon, which corrupted '!' queries on replace.
    const insert = (q && q.trigger === '!' ? '' : ':') + emote.name + ': ';
    chatInput.value =
      chatInput.value.slice(0, start) + insert + chatInput.value.slice(pos);
    const newPos = start + insert.length;
    chatInput.setSelectionRange(newPos, newPos);
    chatInput.focus();
    // Notify the site's own listeners (React/vanilla handlers)
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    hideAutocomplete();
  }

  // ---------- events ----------

  function attachEvents(input) {
    if (input.__vaughnEmoteBound) return; // never double-bind
    input.__vaughnEmoteBound = true;
    input.addEventListener('input', showAutocomplete);
    input.addEventListener('keyup', (e) => {
      // Arrow navigation when dropdown open
      if (dropdown && dropdown.style.display === 'block') {
        if (e.key === 'ArrowDown') {
          activeIndex = (activeIndex + 1) % currentMatches.length;
          renderDropdown(currentMatches);
          e.preventDefault();
        } else if (e.key === 'ArrowUp') {
          activeIndex = (activeIndex - 1 + currentMatches.length) % currentMatches.length;
          renderDropdown(currentMatches);
          e.preventDefault();
        }
      } else if (e.key === ':') {
        showAutocomplete();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (dropdown && dropdown.style.display === 'block') {
        if (e.key === 'Enter' && activeIndex >= 0) {
          e.preventDefault();
          e.stopPropagation();
          selectEmote(currentMatches[activeIndex]);
        } else if (e.key === 'Escape') {
          hideAutocomplete();
        } else if (e.key === 'Tab' && activeIndex >= 0) {
          e.preventDefault();
          selectEmote(currentMatches[activeIndex]);
        }
      }
    });
    input.addEventListener('blur', () => setTimeout(hideAutocomplete, 150));
    input.addEventListener('click', showAutocomplete);
    // The site's own handlers are inline attributes:
    //   onkeyup="return vs_chatv9.submitChat(event, true)"
    //   onkeydown="return vs_chatv9.submitChat(event, false)"
    // Inline attribute handlers run BEFORE addEventListener listeners for the
    // same event. If submitChat() returns false it cancels the default action,
    // which means NO `input` event is ever fired while typing — our primary
    // trigger would silently never run. So we also listen to raw keypress and
    // poll the value on a microtask after each keystroke as a safety net.
    input.addEventListener('keypress', () => setTimeout(showAutocomplete, 0));
    let lastValue = null;
    setInterval(() => {
      try {
        const v = chatInput ? chatInput.value : null;
        if (v !== lastValue) { lastValue = v; showAutocomplete(); }
      } catch (_) {}
    }, 200);
  }

  function buildUI() {
    // The dropdown MUST be appended to the same document that contains the
    // chat input. When the script runs at document_idle and the chat lives
    // inside an iframe, `document` here is the TOP page while `chatInput`
    // belongs to the iframe's document. Appending the popup to the wrong
    // document makes it permanently invisible no matter what we set on it —
    // exactly the "autocomplete never appears" symptom.
    const targetDoc = (chatInput && chatInput.ownerDocument) || document;
    if (dropdown && targetDoc.contains(dropdown)) return; // one per document
    dropdown = null; // drop stale node from a replaced/wrong document
    ensureStyleInThisDocument(targetDoc);
    dropdown = targetDoc.createElement('div');
    dropdown.id = 'vaughn-emote-dropdown';
    dropdown.style.display = 'none';
    (targetDoc.body || targetDoc.documentElement).appendChild(dropdown);
  }

  // The dropdown is only useful in the frame that actually contains the chat
  // input. Frames without an input skip UI entirely (they still harvest and
  // post emotes to the parent).
  function maybeBuildDropdown() {
    if (!chatInput && !tryInitInput()) return;
    if (chatInput) buildUI();
  }

  function tryInitInput() {
    // If the element we previously bound is gone (site re-rendered the chat),
    // drop it so we can discover and bind the new one.
    if (chatInput && !document.contains(chatInput) &&
        !(chatInput.ownerDocument && chatInput.ownerDocument.defaultView)) {
      chatInput = null;
    }
    if (chatInput && document.contains(chatInput)) return true;
    const el = findChatInput();
    if (el) {
      chatInput = el;
      buildUI();
      attachEvents(chatInput);
      console.log('[Vaughn Emotes] Chat input found:',
        `${chatInput.tagName.toLowerCase()}#${chatInput.id || '(no id)'}`,
        '- autocomplete ready.');
      return true;
    }
    return false;
  }

  // ---------- main init ----------

  async function init() {
    // IMPORTANT: the Vaughn chat (input + emoji picker) is rendered inside
    // an iframe, and content scripts run in every frame ("all_frames": true).
    // The old top-frame-only guard made the script exit immediately in the
    // chat iframe — that's why you saw "Loaded 0 emotes" / nothing happened.

    // Build the dropdown ONLY if this frame has the chat input (or when the
    // input appears later — tryInitInput calls buildUI). Frames without an
    // input stay UI-less so we never get invisible/duplicate dropdowns.
    tryInitInput();
    await loadEmotes();

    // If this frame has no chat input at all, it's probably the top page
    // while the real chat lives in a same-origin iframe (the content script
    // runs there too thanks to all_frames). Wait a bit and re-check before
    // giving up — avoids duplicate dropdowns / double virtual clicks.
    if (!chatInput && emotes.size === 0) {
      setTimeout(() => {
        if (!chatInput && emotes.size === 0 && !document.querySelector('iframe')) {
          if (pendingChildEmotes.length > 0) {
            console.warn(
              '[Vaughn Emotes] Chat iframe detected its own picker but rendered no emote items. ' +
              'Copy the [Vaughn Emotes] DIAGNOSTICS output from the IFRAME console (devtools frame selector) here.'
            );
          } else {
            console.warn('[Vaughn Emotes] No chat input or iframes found in this frame.');
          }
        }
      }, 8000);
    }

    // The chat UI may render late or be replaced; watch for it.
    let domParseThrottle = 0;
    observer = new MutationObserver(() => {
      // Hook any same-origin iframes that appeared after load, so their
      // addEventListener('click') calls are recorded too.
      try {
        document.querySelectorAll('iframe').forEach((f) => hookDocument(f.contentDocument));
      } catch (_) {}
      if (!chatInput || !document.contains(chatInput)) {
        chatInput = null;
        tryInitInput();
      }
      // The picker may render/change whenever the USER opens the emoji menu.
      // Merge silently (throttled) so the store converges on the full list
      // even if our virtual click never found the right toggle button.
      if (emotes.size < MIN_FULL_LIST && Date.now() - domParseThrottle > 500) {
        domParseThrottle = Date.now();
        const domList = silentDomParse();
        if (domList.length >= 10) {
          const before = emotes.size;
          storeEmotes(domList);
          if (emotes.size !== before) {
            console.log(`[Vaughn Emotes] Merged ${emotes.size} emotes from DOM (picker detected; +${emotes.size - before}).`);
            maybeBuildDropdown();
            if (!isTopFrame()) postEmotesToParent(Array.from(emotes.values()));
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Live-merge directly inside chat iframe documents too (their own
    // MutationObservers see their own lazy renders immediately).
    startLiveMerge(document);
    try {
      document.querySelectorAll('iframe').forEach((f) => {
        try { if (f.contentDocument) startLiveMerge(f.contentDocument); } catch (_) {}
      });
    } catch (_) {}

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideAutocomplete();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
