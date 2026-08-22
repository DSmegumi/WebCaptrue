# WebCaptrue

WebCaptrue is a one-click offline web capture extension designed for restricted/intranet environments where AI development tools cannot be used directly.

The extension records browser-observable data during a business workflow and exports it as a ZIP package for later analysis with Codex or other AI tools.

## Compatibility target

- Google Chrome 109+
- Windows 7 compatibility is a hard requirement
- Manifest V3
- No cloud dependency required for capture

## Current v0.1.0 scope

- One-click start / stop capture
- Chrome DevTools Protocol via `chrome.debugger`
- Initial page-resource recovery with `Page.getResourceTree` / `Page.getResourceContent`
- HTTP, XHR and Fetch request/response metadata
- Response bodies (size-limited)
- Sanitized HAR export
- WebSocket frames
- EventSource / SSE events
- Console messages and runtime exceptions
- Navigation timeline
- Click, input, change and submit interaction timeline
- DOM snapshots
- localStorage / sessionStorage snapshots
- Screenshots at capture milestones
- Dynamic JavaScript source capture
- Local ZIP export
- Default redaction of common credential headers and sensitive fields

## Chrome 109 design constraints

Chrome 109 is the baseline. Features introduced after Chrome 109 must not become mandatory unless a Chrome 109-compatible fallback is retained.

In particular, WebCaptrue uses an offscreen document keepalive strategy because the later `chrome.debugger` service-worker lifetime behavior is not available in Chrome 109.

## Development

No build step is required for the extension itself.

Validate the repository with:

```bash
npm run validate
```

Load the repository directory through `chrome://extensions` using **Load unpacked**.

## Security

Captured sessions can contain sensitive internal business data. Authentication-related headers and common secret fields are redacted by default, but exported files must still be handled according to the security policy of the environment being captured.

## Project status

Early development / v0.1.0 bootstrap.
