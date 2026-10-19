# MultiHeiz third-party extensions — license choice

## Decision (v1.9 Phase 3a)

**Own minimal layer** in `src/main/extensions/` (MIT, same as MultiHeiz).

We did **not** add `electron-chrome-extensions` (GPL-3.0 / proprietary) or
`electron-chrome-web-store` (MIT) as dependencies.

### Why not electron-chrome-extensions (GPL-3)?

| Factor | Detail |
|--------|--------|
| Sessions | MultiHeiz uses one `persist:acc-*` partition **per window**. ECE is built around a single browser session + `addTab`. Wiring N partitions cleanly is awkward. |
| License | MultiHeiz is **MIT**. Bundling GPL-3 ECE would require the combined distributed app to be GPL-3 (or buying the author's proprietary license). Fine for Leo's personal use; painful if MultiHeiz is ever redistributed under MIT. |
| Phase 3a scope | Install / CRX / store download / enable / content scripts / action popup / options are doable with Electron's native `session.extensions.loadExtension` + a small BrowserWindow popup. Full `chrome.tabs` / `<browser-action-list>` can wait. |

### Why not electron-chrome-web-store (MIT)?

Useful for CWS install/update, but Edge Add-ons still need custom endpoints. We call the **official** Chrome / Edge update redirect URLs ourselves and unpack CRX2/CRX3 in this folder — one code path, no extra preload packaging.

### Swap path

Public API is isolated here (`init`, `list`, `install*`, `setEnabled`, `remove`, `loadForAccount`, `openActionPopup`, `openOptions`). A future phase can put ECE behind the same interface if richer APIs are needed (e.g. AdBlocker Ultimate popup/background). Document any GPL switch in README + Sobre before shipping a redistributable build.

### Dependencies used

| Package | License | Role |
|---------|---------|------|
| `adm-zip` | MIT | Unzip CRX payload / pack CRX3 test fixture |
