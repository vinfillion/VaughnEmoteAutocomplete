// Integration test: simulates the "chat lives in a same-origin iframe,
// emotes render lazily when the picker is opened" scenario.
const { JSDOM } = require('jsdom');
const vm = require('vm');

// Minimal EventTarget-based Node/Element classes for the addEventListener hook.
class VNode extends EventTarget {}
class VElement extends VNode {}

const mainHtml = `<!DOCTYPE html><html><body>
<div id="outer">not the chat</div>
</body></html>`;

const frameHtml = `<!DOCTYPE html><html><body>
<div class="vs_chatv9_footer">
  <input class="vs_chatv9_input" type="text">
  <button class="vs_chatv9_emoji_button" title="Emojis"><span>&#128512;</span></button>
  <div id="picker"></div>
</div>
<script>
  var btn = document.querySelector('.vs_chatv9_emoji_button');
  btn.addEventListener('click', function () {
    var p = document.getElementById('picker');
    if (p.children.length) return;
    for (var i = 0; i < 7; i++) {
      var d = document.createElement('div');
      d.className = 'vs_chatv9_emoji_item';
      d.setAttribute('title', '(emote' + i + ')');
      d.setAttribute('onclick', "insertEmoji('id" + i + "','name')");
      var img = document.createElement('img');
      img.src = '/emotes/e' + i + '.png';
      img.width = 60; img.height = 60;
      d.appendChild(img);
      p.appendChild(d);
    }
  });
</script>
</body></html>`;

(async () => {
  const fs = require('fs');
  const contentSrc = fs.readFileSync(__dirname + '/content.js', 'utf8');

  // Main page: loads content script early, then injects chat iframe late.
  const dom = new JSDOM(mainHtml, {
    url: 'https://vaughn.live/stream',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  const logs = [];
  const origLog = win.console.log.bind(win.console);
  win.console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
  win.console.warn = (...a) => logs.push('WARN: ' + a.join(' '));

  // Inject content.js into the MAIN world (like all_frames content scripts).
  const s = win.document.createElement('script');
  s.textContent = contentSrc.replace('window.location.origin + window.location.pathname', '"https://vaughn.live/stream"');
  win.document.body.appendChild(s);

  await new Promise((r) => setTimeout(r, 300));

  // Now inject the chat iframe with its lazy picker (site renders chat late).
  const iframeEl = win.document.createElement('iframe');
  win.document.body.appendChild(iframeEl);
  const idoc = iframeEl.contentDocument;
  idoc.open();
  idoc.write(frameHtml.replace('<script>', '<script>document._isIframe=true;'));
  idoc.close();

  // Wait for MutationObserver re-scan -> virtual click -> lazy render -> harvest.
  await new Promise((r) => setTimeout(r, 8000));

  const out = logs.join('\n');
  const itemsRendered = idoc.querySelectorAll('.vs_chatv9_emoji_item').length;
  const titles = Array.from(idoc.querySelectorAll('.vs_chatv9_emoji_item')).map(e => e.getAttribute('title'));
  console.log('picker items after virtual click:', itemsRendered);
  console.log('titles:', JSON.stringify(titles));
  console.log('relevant logs:\n' + out.split('\n').filter(l => /Loaded|Virtual|listener|DOM parse|Generic/.test(l)).join('\n'));

  const loaded = /Loaded \d+ emotes via virtual picker click/.test(out);
  const pass = itemsRendered === 7 && loaded;
  console.log(pass ? 'TEST PASS: cross-frame virtual click rendered + harvested 7 emotes' : 'TEST FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
