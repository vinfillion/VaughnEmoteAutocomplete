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

  let virtualRefreshScheduled = false;
  let lastVirtualClickAt = 0;
  const VIRTUAL_CLICK_COOLDOWN_MS = 5 * 1000;   // retry quickly, capped by MAX_ATTEMPTS
  const VIRTUAL_CLICK_MAX_ATTEMPTS = 8;
  let virtualClickAttempts = 0;

  function scheduleVirtualEmoteLoad(delayMs) {
    if (virtualRefreshScheduled || emotes.size > 0) return;
    if (Date.now() - lastVirtualClickAt < VIRTUAL_CLICK_COOLDOWN_MS) return;
    virtualRefreshScheduled = true;
    setTimeout(() => {
      virtualRefreshScheduled = false;
      virtualLoadEmotesByClickingPicker();
    }, delayMs || 2500);
  }

  // Parse emote name - remove surrounding parentheses/brackets
  const parseEmoteName = (name) => (name || '').replace(/^[\(\)\[\]:]+|[\(\)\[\]:]+$/g, '').trim();

  function findChatInput() {
    // Most specific selectors first; fall back to generic ones.
    const selectors = [
      'input.vs_chatv9_input',
      '.vs_chatv9_footer input[type="text"]',
      'input[placeholder*="chat" i]',
      'input[placeholder*="message" i]',
      'input[placeholder*="Send" i]',
      'textarea',
      'input[type="text"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el; // visible elements only
    }
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

  function findEmojiButton() {
    // Search the *document that actually contains the chat input*, not just
    // our own. With all_frames:true the script runs in every frame; if the
    // chat lives inside a same-origin iframe, the emoji button is in THAT
    // frame's document and a plain document.querySelector can never see it.
    const docs = new Set([document]);
    if (chatInput && chatInput.ownerDocument) docs.add(chatInput.ownerDocument);
    try {
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        if (f.contentDocument) {
          hookDocument(f.contentDocument); // record addEventListener('click') calls
          docs.add(f.contentDocument);
        }
      }
    } catch (_) {}

    for (const doc of docs) {
      let scope = doc.body;
      if (doc === (chatInput && chatInput.ownerDocument) && chatInput) {
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

  // THE MAIN LOADER: virtually open the emoji picker, harvest items, close it.
  async function virtualLoadEmotesByClickingPicker() {
    if (emotes.size > 0) return;
    if (virtualClickAttempts >= VIRTUAL_CLICK_MAX_ATTEMPTS) {
      console.warn('[Vaughn Emotes] Gave up after ' + virtualClickAttempts + ' virtual picker attempts.');
      return;
    }
    virtualClickAttempts += 1;
    lastVirtualClickAt = Date.now();

    tryInitInput();

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
      const docs = new Set([document]);
      try {
        document.querySelectorAll('iframe').forEach((f) => {
          if (f.contentDocument && f.contentDocument.body) docs.add(f.contentDocument);
        });
      } catch (_) {}
      for (const doc of docs) {
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
        storeEmotes(list);
        console.log(`[Vaughn Emotes] Loaded ${emotes.size} emotes via virtual picker click.`);
      } else {
        console.warn(
          `[Vaughn Emotes] Virtual picker click (attempt ${virtualClickAttempts}/${VIRTUAL_CLICK_MAX_ATTEMPTS}) rendered no emote items.`
        );
        dumpEmojiDiagnostics();
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

    if (emotes.size === 0) scheduleVirtualEmoteLoad(3000);
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
  function parseEmotesGenericFromDOM(doc) {
    doc = doc || document;
    const candidates = doc.querySelectorAll(
      '[title] img, [title] > img, button img, [role="button"] img, li img, span[class] img, div[class] img'
    );
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
    for (const sel of EMOTE_ITEM_SELECTORS) {
      const items = doc.querySelectorAll(sel);
      if (items.length === 0) continue;
      const parsed = extractEmotes(items);
      if (parsed.length > 0) {
        console.log(`[Vaughn Emotes] DOM parse: ${parsed.length} emotes via "${sel}"`);
        return parsed;
      }
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

  let loadedFromHtml = false;

  async function loadEmotes() {
    // The emoji list is rendered lazily (only when the picker is opened),
    // so a plain DOM query at page-load will find nothing. Try anyway —
    // maybe the user already opened it or the site pre-renders it.
    let list = parseEmotesFromDOM();
    if (list.length === 0 && !loadedFromHtml) {
      // Fallback: some servers do include the picker markup in the HTML.
      list = await fetchEmotesHTML();
      if (list.length > 0) loadedFromHtml = true;
    }
    storeEmotes(list);
    console.log(`[Vaughn Emotes] Loaded ${emotes.size} emotes`);

    if (emotes.size === 0) {
      // Nothing yet -> virtually open the emoji picker to force-render it.
      scheduleVirtualEmoteLoad();
    }
  }

  // ---------- autocomplete UI ----------

  function getQuery() {
    if (!chatInput) return null;
    const pos = chatInput.selectionStart;
    const textUpToCursor = chatInput.value.slice(0, pos);
    for (const trigger of TRIGGER_CHARS) {
      const idx = textUpToCursor.lastIndexOf(trigger);
      if (idx === -1) continue;
      const query = textUpToCursor.slice(idx + 1);
      // Query must have no whitespace after it (it's a live word being typed)
      if (/^\S+$/.test(query) || query === '') {
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
    const rect = chatInput.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
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
    const q = getQuery();
    if (!q) return hideAutocomplete();
    currentMatches = matchEmotes(q.query);
    if (currentMatches.length === 0) return hideAutocomplete();
    activeIndex = 0;
    renderDropdown(currentMatches);
    positionDropdown();
    dropdown.style.display = 'block';
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
    const insert = `:${emote.name}: `;
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
  }

  function buildUI() {
    dropdown = document.createElement('div');
    dropdown.id = 'vaughn-emote-dropdown';
    dropdown.style.display = 'none';
    document.documentElement.appendChild(dropdown);
  }

  function tryInitInput() {
    if (chatInput) return true;
    chatInput = findChatInput();
    if (chatInput) {
      attachEvents(chatInput);
      console.log('[Vaughn Emotes] Chat input found, autocomplete ready.');
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

    buildUI();
    tryInitInput();
    await loadEmotes();

    // If this frame has no chat input at all, it's probably the top page
    // while the real chat lives in a same-origin iframe (the content script
    // runs there too thanks to all_frames). Wait a bit and re-check before
    // giving up — avoids duplicate dropdowns / double virtual clicks.
    if (!chatInput && emotes.size === 0) {
      setTimeout(() => {
        if (!chatInput && emotes.size === 0 && !document.querySelector('iframe')) {
          console.warn('[Vaughn Emotes] No chat input or iframes found in this frame.');
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
      // If emotes haven't loaded yet (picker not rendered on first pass),
      // retry parsing from DOM whenever the page mutates — this catches
      // the case where the USER opens the emoji picker themselves, and
      // also when our virtual click renders it. Throttled to avoid
      // re-parsing on every single mutation.
      if (emotes.size === 0 && Date.now() - domParseThrottle > 500) {
        domParseThrottle = Date.now();
        const domList = parseEmotesFromDOM();
        if (domList.length) {
          storeEmotes(domList);
          console.log(`[Vaughn Emotes] Loaded ${emotes.size} emotes (picker detected in DOM).`);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

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
