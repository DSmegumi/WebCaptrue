# WebCaptrue development rules

- Chrome 109 on Windows 7 is the hard compatibility baseline.
- Do not use Chrome extension APIs introduced after Chrome 109 unless a Chrome 109 fallback exists and is tested.
- Keep `minimum_chrome_version` at `109` unless the product requirement changes explicitly.
- Manifest V3 only. Do not introduce Manifest V2 as the primary implementation.
- No remotely hosted executable code, `eval`, dynamic code loading, telemetry, analytics, or external runtime dependencies.
- The extension must remain usable fully offline after installation.
- Prefer browser-native APIs and dependency-free code so an unpacked build can be loaded directly.
- `chrome.runtime.onMessage` listeners must use callback + `return true` for async replies; do not rely on Promise-returning listeners because Chrome 109 compatibility is required.
- Chrome 109 does not keep an extension service worker alive merely because `chrome.debugger` is attached. Keep the Offscreen Document heartbeat path working.
- Redact `Authorization`, `Proxy-Authorization`, `Cookie`, and `Set-Cookie` headers by default. Never record password input values.
- Any future "sensitive capture" mode must be explicit opt-in, visibly indicated, and isolated from the default mode.
- Keep capture/export schemas versioned. Existing archive readers must not silently break.
- Validate syntax and `manifest.json` before each commit.
