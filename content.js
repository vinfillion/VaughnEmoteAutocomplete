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
  // user opens the emoji picker (or after a site XHR fills it). So we
  // watch for the picker button and "virtually click" it in the
  // background to force-render the list, then restore the page state.
  let virtualRefreshScheduled = false;
  let lastVirtualClickAt = 0;
  const VIRTUAL_CLICK_COOLDOWN_MS = 60 * 1000;   // don't spam-click
  const VIRTUAL_CLICK_MAX_ATTEMPTS = 3;
  let virtualClickAttempts = 0;

  function scheduleVirtualEmoteLoad() {
    if (virtualRefreshScheduled || emotes.size > 0) return;
    if (Date.now() - lastVirtualClickAt < VIRTUAL_CLICK_COOLDOWN_MS) return;
    virtualRefreshScheduled = true;
    setTimeout(() => {
      virtualRefreshScheduled = false;
      virtualLoadEmotesByClickingPicker();
    }, 2500);
  }

  // ---------- helpers ----------

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

  // ---------- emote loading ----------

  // ---------- debug helper ----------
  // Run this in the page console (or read its output in the add-on content
  // script console) when loading fails: it dumps every candidate "emoji-ish"
  // element and every image src pattern near the chat input, so we can see
  // what the real markup actually is instead of guessing selectors.
  function dumpEmojiDiagnostics() {
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
          tag: el.tagName,
          id: el.id,
          class: typeof el.className === 'string' ? el.className : '',
          title: el.getAttribute('title'),
          aria: el.getAttribute('aria-label'),
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
          title: el.getAttribute('title'),
          aria: el.getAttribute('aria-label'),
          text: (el.textContent || '').trim().slice(0, 10),
        });
      });
    }

    const seenSrc = new Set();
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      // normalize: strip trailing filename to group by directory/pattern
      const dir = src.replace(/[^/]*$/, '');
      if (!seenSrc.has(dir) && src) {
        seenSrc.add(dir);
        if (info.imgSrcSamples.length < 20) info.imgSrcSamples.push(src.slice(0, 140));
      }
    });

    console.log('[Vaughn Emotes] DIAGNOSTICS:', JSON.stringify(info, null, 2));
    return info;
  }
  // Expose it so you can call it manually from the console too.
  try { window.__vaughnEmoteDiag = dumpEmojiDiagnostics; } catch (_) {}

  // Find the emoji-picker toggle button next to the chat input.
  // Broadened strategy: class hints, aria/title hints, AND unicode emoji
  // glyphs as button content (many sites use a bare 😀/😃 text icon).
  const EMOJI_GLYPH_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

  function looksLikeEmojiToggle(el) {
    if (!el || el === chatInput) return false;
    const label = (
      (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) ||
      (el.textContent || '')
    ).toLowerCase();
    const cls = (el.className && String(el.className)).toLowerCase();
    return /emoji|emote|smile|face/.test(cls) ||
           /emoji|emote|smile|face/.test(label) ||
           EMOJI_GLYPH_RE.test(label);
  }

  function searchDocForEmojiButton(doc) {
    // 1. Direct class match for the toggle (vs_chatv9_emoji_button etc.)
    const direct = doc.querySelector(
      'button[class*="emoji"], [class*="emoji_button"], [class*="emoji-btn"], [class*="emojibtn"], [class*="emote"]'
    );
    if (direct) return direct;

    // 2. Label/aria/title hints
    const labeled = doc.querySelector(
      '[title*="moji" i], [aria-label*="moji" i], [title*="mote" i], [aria-label*="mote" i]'
    );
    if (labeled) return labeled;

    // 3. Any clickable whose class/label/glyph suggests an emoji toggle.
    const candidates = doc.querySelectorAll(
      'button, [role="button"], a, span[class*="emoji"], div[class*="emoji"], i[class*="emoji"], svg[class*="emoji"]'
    );
    for (const el of candidates) {
      if (looksLikeEmojiToggle(el)) return el;
    }
    return null;
  }

  function findEmojiButton() {
    const scope = chatInput
      ? (chatInput.closest('[class*="chat"], form, [class*="footer"], [class*="input"]') || document.body)
      : document.body;

    const local = searchDocForEmojiButton(scope.nodeType === 9 ? scope : (scope.closest('body') ? scope : scope));
    if (local) return local;

    // Whole-document fallback (scope may have been too narrow).
    const globalBtn = searchDocForEmojiButton(document);
    if (globalBtn) return globalBtn;

    // Chat inputs often live in an iframe with the picker. Search all
    // same-origin frames too.
    try {
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        const d = f.contentDocument;
        if (!d) continue; // cross-origin, skip silently
        const inFrame = searchDocForEmojiButton(d);
        if (inFrame) return inFrame;
      }
    } catch (_) { /* ignore frame access errors */ }

    return null;
  }

  // Wait until either emotes appear in the DOM, or timeout.
  // Returns the parsed list (possibly empty).
  function waitForDomEmotes(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        const list = parseEmotesFromDOM();
        if (list.length > 0 || Date.now() - start > timeoutMs) {
          resolve(list);
          return;
        }
        setTimeout(poll, 150);
      };
      poll();
    });
  }

  // THE MAIN LOADER: virtually open the emoji picker, harvest the items,
  // then close it again so the user never sees anything happen.
  async function virtualLoadEmotesByClickingPicker() {
    if (emotes.size > 0) return;
    if (virtualClickAttempts >= VIRTUAL_CLICK_MAX_ATTEMPTS) return;
    virtualClickAttempts += 1;
    lastVirtualClickAt = Date.now();

    // The chat UI may not be rendered yet; make sure we at least have the
    // right document scope before searching for the emoji button.
    tryInitInput();

    const btn = findEmojiButton();
    if (!btn) {
      console.warn('[Vaughn Emotes] Virtual load: emoji picker button not found yet.');
      scheduleVirtualEmoteLoad(); // retry later once the chat renders
      return;
    }

    // Record page state so we can undo our interference.
    const hadFocus = document.activeElement;

    // Keep the picker invisible while we harvest it: hide ONLY elements
    // that newly appear after the click (never the whole page — the old
    // "anim killer" set visibility:hidden on <html>, which could stop the
    // lazy rendering we were trying to trigger).
    const beforeNodes = new WeakSet();
    document.querySelectorAll('body *').forEach((el) => beforeNodes.add(el));
    const hiddenForHarvest = [];
    const suppressNewPopups = () => {
      document.querySelectorAll('body *').forEach((el) => {
        if (beforeNodes.has(el) || hiddenForHarvest.includes(el)) return;
        const cs = getComputedStyle(el);
        const pos = cs.position;
        if ((pos === 'fixed' || pos === 'absolute') && el.offsetHeight > 40 && el.offsetWidth > 40) {
          el.style.setProperty('visibility', 'hidden', 'important');
          hiddenForHarvest.push(el);
        }
      });
    };

    function fullClickSequence(el) {
      const doc = el.ownerDocument;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
      const x = rect.left + Math.max(rect.width / 2, 1);
      const y = rect.top + Math.max(rect.height / 2, 1);
      const base = { bubbles: true, cancelable: true, view: doc.defaultView, clientX: x, clientY: y };
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.focus && el.focus({ preventScroll: true });
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
      // React/other frameworks sometimes listen for these too:
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    }

    let harvestTimer = null;
    try {
      // Start watching for the popup a tick BEFORE clicking, then click.
      fullClickSequence(btn);
      harvestTimer = setInterval(suppressNewPopups, 50);
      suppressNewPopups();

      // Give the site time to render (or XHR-fill) the emoji list.
      const list = await waitForDomEmotes(4000);

      if (list.length > 0) {
        storeEmotes(list);
        console.log(`[Vaughn Emotes] Loaded ${emotes.size} emotes via virtual picker click.`);
      } else {
        console.warn(
          '[Vaughn Emotes] Virtual picker click rendered no emote items.',
          'Button matched was:', btn.tagName, btn.className || '(no class)',
          '| Run window.__vaughnEmoteDiag() in this frame\'s console and send me the output.'
        );
        dumpEmojiDiagnostics();
      }
    } finally {
      if (harvestTimer) clearInterval(harvestTimer);
      hiddenForHarvest.forEach((el) => el.style.removeProperty('visibility'));

      // Close the picker again: Escape, then toggle-click if still open.
      const doc2 = btn.ownerDocument;
      (doc2.activeElement || doc2.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      if (parseEmotesFromDOM().length > 0) {
        fullClickSequence(btn); // popup still open -> click the toggle to close it
      }

      if (hadFocus && typeof hadFocus.focus === 'function') hadFocus.focus({ preventScroll: true });
    }

    if (emotes.size === 0) scheduleVirtualEmoteLoad(); // one more chance later
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
  function parseEmotesGenericFromDOM() {
    const candidates = document.querySelectorAll(
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

  function parseEmotesFromDOM() {
    for (const sel of EMOTE_ITEM_SELECTORS) {
      const items = document.querySelectorAll(sel);
      if (items.length === 0) continue;
      const parsed = extractEmotes(items);
      if (parsed.length > 0) {
        console.log(`[Vaughn Emotes] DOM parse: ${parsed.length} emotes via "${sel}"`);
        return parsed;
      }
    }
    return parseEmotesGenericFromDOM();
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
