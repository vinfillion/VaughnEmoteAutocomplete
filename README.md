# Vaughn Emote Autocomplete

A Firefox extension that adds emote autocompletion to the [vaughn.live](https://vaughn.live) chat.

## Features

- Type `:` in the chat box to open an emote suggestion dropdown (the full vaughn.live emote list, ~1600 emotes).
- Arrow keys navigate suggestions; **Enter** or clicking inserts the selected emote without sending the message.
- **Tab** performs inline autocomplete: it completes the current word to the first matching emote (and never moves focus out of the chat box).
- Emotes are loaded automatically when the page opens (via the site's own picker API), so you never have to open the emoji menu manually.

## Install

Install from addons.mozilla.org (link once published), or load it temporarily for development:

1. Open `about:debugging#/runtime/this-firefox`
2. Click *Load Temporary Add-on…* and select `manifest.json` in this folder.

## Building the XPI

```sh
zip -r vaughn-emote-autocomplete-<version>.xpi manifest.json content.js content.css LICENSE assets README.md
```

The resulting `.xpi` can be submitted to [addons.mozilla.org](https://addons.mozilla.org/firefox/developers/) for review, or installed via *Debug Enabled Extensions* / self-signing with [`web-ext`](https://extensionworkshop.com/documentation/tools/extension-workshop/).

## Debug logging

Console output is off by default. To enable it (per frame), run in DevTools console on vaughn.live:

```js
localStorage.setItem('vaughn-emote-debug', '1')
```

then reload the page. Set it back to `'0'` to silence again.

## License

MIT — see [LICENSE](LICENSE).
