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

  // Snapshot the current inline styles of an element so we can restore them.
  function snapshotStyle(el) {
    return el ? el.getAttribute('style') : null;
  }
  function restoreStyle(el, snap) {
    if (!el) return;
    if (snap === null) el.removeAttribute('style');
    else el.setAttribute('style', snap);
  }

  // Find the emoji-picker toggle button next to the chat input.
  // Strategy: start from the input's containing area and look for small
  // clickable elements that are likely the emoji button — by class hint,
  // by aria/title text, or by being a bare <button> near the send button.
  function looksLikeEmojiToggle(el) {
    if (!el || el === chatInput) return false;
    const label = (
      el.getAttribute('title') ||
      el.getAttribute('aria-label') ||
      el.textContent || ''
    ).toLowerCase();
    const cls = (el.className && String(el.className)).toLowerCase();
    return /emoji|emote/.test(cls) || /emoji|emote|smile/.test(label);
  }

  function findEmojiButton() {
    const scope = chatInput
      ? (chatInput.closest('[class*="chat"], form, [class*="footer"], [class*="input"]') || document.body)
      : document.body;

    // 1. Direct class match for the toggle (vs_chatv9_emoji_button etc.)
    const direct = scope.querySelector(
      'button[class*="emoji"], [class*="emoji_button"], [class*="emoji-btn"], [class*="emojibtn"]'
    );
    if (direct) return direct;

    // 2. Any clickable element whose class/label mentions emoji/emote.
    const candidates = scope.querySelectorAll(
      'button, [role="button"], a, span[class*="emoji"], div[class*="emoji"], i[class*="emoji"], svg[class*="emoji"]'
    );
    for (const el of candidates) {
      if (looksLikeEmojiToggle(el)) return el;
    }

    // 3. Chat inputs often live in an iframe with the picker. Search all
    //    same-origin frames too.
    try {
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        const d = f.contentDocument;
        if (!d) continue; // cross-origin, skip silently
        const inFrame = d.querySelector(
          'button[class*="emoji"], [class*="emoji_button"], [title*="moji" i], [aria-label*="moji" i]'
        );
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
    const bodySnap = snapshotStyle(document.body);

    // Temporarily neutralize transitions/animations so opening & closing
    // the popup is instant and invisible.
    const animKiller = document.createElement('style');
    animKiller.textContent =
      '#vaughn-emote-anim-killer *, #vaughn-emote-anim-killer {' +
      'animation: none !important; transition: none !important; visibility: hidden !important;' +
      '}';
    animKiller.id = 'vaughn-emote-anim-killer-root';
    document.documentElement.appendChild(animKiller);
    // Apply the killer class to html so the rule above matches everything:
    document.documentElement.classList.add('vaughn-emote-anim-killer');

    try {
      // Open the picker via a synthetic click sequence (some sites only
      // react to pointer/mouse events, so fire both).
      btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mousedown',  { bubbles: true, cancelable: true }));
      btn.click();
      btn.dispatchEvent(new MouseEvent('mouseup',    { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click',      { bubbles: true, cancelable: true }));

      // Give the site time to render (or XHR-fill) the emoji list.
      const list = await waitForDomEmotes(4000);

      if (list.length > 0) {
        storeEmotes(list);
        console.log(`[Vaughn Emotes] Loaded ${emotes.size} emotes via virtual picker click.`);
      } else {
        console.warn('[Vaughn Emotes] Virtual picker click rendered no emote items.');
      }
    } finally {
      // Close the picker again: press Escape, click elsewhere, then click
      // the toggle back if it's still open.
      document.documentElement.classList.remove('vaughn-emote-anim-killer');
      animKiller.remove();

      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (parseEmotesFromDOM().length > 0) {
        // Popup still open -> click the toggle again to close it
        btn.click();
      }

      restoreStyle(document.body, bodySnap);
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
