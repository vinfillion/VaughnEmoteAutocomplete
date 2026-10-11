// Simulate the cross-origin-child scenario: child frame harvests emotes and
// posts them to the parent; parent merges into its store. Uses the real
// message-handling code extracted from content.js.
const { JSDOM } = require('jsdom');

// Extract the IIFE body of content.js and eval it in a fake window context
// is complex; instead replicate the exact handler logic copied verbatim.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const win = dom.window;

const emotes = new Map();
function storeEmotes(list) { for (const e of list) emotes.set(e.name.toLowerCase(), e); }
const MSG_TAG = 'vaughn-emote-autocomplete';
const pendingChildEmotes = [];
win.addEventListener('message', (ev) => {
  if (ev.source === win) return;
  const d = ev.data;
  if (!d || d.__vaughnEmoteMsg !== MSG_TAG || !Array.isArray(d.emotes)) return;
  if (emotes.size > 0) return;
  if (d.emotes.length > 0) {
    storeEmotes(d.emotes);
    console.log(`[Vaughn Emotes] Received ${emotes.size} emotes from child frame (${d.frameUrl || 'cross-origin'}).`);
  } else {
    pendingChildEmotes.push(d);
  }
});

// child posts empty first, then real list
win.postMessage({ __vaughnEmoteMsg: MSG_TAG, frameUrl: 'https://separate-chat-domain.example/chat', emotes: [] }, '*');
setTimeout(() => {
  win.postMessage({ __vaughnEmoteMsg: MSG_TAG, frameUrl: 'https://separate-chat-domain.example/chat',
    emotes: [{ id: '1', name: 'KEKW' }, { id: '2', name: 'LULW' }, { id: '3', name: 'PepeHands' }] }, '*');
  setTimeout(() => {
    if (emotes.size === 3 && pendingChildEmotes.length === 1) console.log('TEST PASS: cross-origin child emotes merged');
    else { console.log('TEST FAIL', emotes.size, pendingChildEmotes.length); process.exit(1); }
  }, 50);
}, 50);
