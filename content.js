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

  const DOM_URL = 'https://vaughn.live';
  const TRIGGER_CHARS = [':', '!'];       // characters that start a query
  const MAX_SUGGESTIONS = 12;
  const MIN_QUERY_LEN = 1;                // show suggestions after 1 char

  let chatInput = null;
  let emotes = new Map();                 // name(lowercase) -> emote object
  let dropdown = null;
  let activeIndex = -1;
  let currentMatches = [];
  let observer = null;

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

  function parseEmotesFromDOM() {
    const emoteItems = document.querySelectorAll('.vs_chatv9_emoji_item');
    if (emoteItems.length === 0) return [];

    return Array.from(emoteItems).map((item) => {
      const title = item.getAttribute('title') || '';
      const onclick = item.getAttribute('onclick') || '';
      const idMatch = onclick.match(/insertEmoji\(['"]([^'"]+)['"]\s*,/);
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

  async function fetchEmotesHTML() {
    try {
      const res = await fetch(DOM_URL, { credentials: 'include' });
      const html = await res.text();

      // Match each emoji item div, capturing BOTH title and onclick so
      // each emote keeps its OWN id (the old code reused one global match).
      const re = /<div class="vs_chatv9_emoji_item" onclick="([^"]*)"[^>]*title="([^"]*)"/g;
      const results = [];
      let m;
      while ((m = re.exec(html)) !== null) {
        const onclick = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const idMatch = onclick.match(/insertEmoji\(['"]([^'"]+)['"]\s*,/);
        const name = parseEmoteName(m[2]);
        if (!name) continue;
        results.push({ id: idMatch ? idMatch[1] : '', name, filename: '', width: 60, height: 60 });
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

  async function loadEmotes() {
    // Prefer live DOM (the emoji picker may already be rendered);
    // fall back to fetching the page HTML.
    let list = parseEmotesFromDOM();
    if (list.length === 0) {
      list = await fetchEmotesHTML();
    }
    storeEmotes(list);
    console.log(`[Vaughn Emotes] Loaded ${emotes.size} emotes`);
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
    // Only run in the top frame / actual chat page context
    if (window.top !== window.self) return;

    buildUI();
    tryInitInput();
    await loadEmotes();

    // The chat UI may render late or be replaced; watch for it.
    observer = new MutationObserver(() => {
      if (!chatInput || !document.contains(chatInput)) {
        chatInput = null;
        tryInitInput();
      }
      // If emotes haven't loaded yet (picker not rendered on first pass),
      // retry parsing from DOM whenever the page mutates.
      if (emotes.size === 0) {
        const domList = parseEmotesFromDOM();
        if (domList.length) storeEmotes(domList);
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
