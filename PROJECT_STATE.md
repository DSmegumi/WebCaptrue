# Project State

## Last Updated

2026-08-23

## Current Objective

Protect capture completeness and structural fidelity first, then apply auditable export-time redaction, while preserving the Chrome 109 / Windows 7 baseline.

## Current State

The extension now completes real start/stop/export flows in macOS Chrome 151. A local E2E fixture confirms page, iframe, cross-origin iframe, Dedicated Worker, pre-existing Shared Worker, Service Worker, Fetch, WebSocket, SSE, DOM, storage, screenshots, interaction, and exception paths. The hard Windows 7 / Chrome 109 acceptance gate remains untested.

## Completed Work

- Added Chrome-version-aware child Target capture: flat sessions on Chrome 125+ and scoped `targetId` polling fallback for Chrome 109.
- Added a global, same-origin Target sweep so a Shared Worker that existed before capture is still attached; real export evidence includes its request, response, and response body.
- Added explicit completeness output: `integrity/completeness.json`, failures, truncations, exclusions, and export-stage redaction audit.
- Added idempotent content-script injection so capture can start on an already-open page.
- Added click-operable popup flow plus `Ctrl+Shift+Y` command/page bridge.
- Preserved JSON-string storage structure while redacting sensitive field values.
- Excluded third-party `chrome-extension://` bodies and sources from webpage artifacts while retaining metadata and an explicit exclusion record.
- Removed large payload duplication from `timeline.jsonl`; the equivalent data remains in its canonical archive directory.
- Added a persistent two-origin E2E fixture covering Fetch GET/POST, iframe/OOPIF, Dedicated/Shared/Service Worker, WebSocket, SSE, IndexedDB, Cache Storage, SPA navigation, and exceptions.
- Added integrity regression tests for Chrome 109 routing, target scoping, storage redaction, SSE completeness, exclusions, source-code structural redaction, and structured DOM password redaction.

## Validation Status

### Completed

- `npm test`: passed manifest/API baseline, syntax, integrity, ZIP, and smoke checks.
- `git diff --check`: passed.
- Real Chrome 151 popup automation: actual toolbar icon → start → interactions → stop → ZIP download completed.
- `WebCaptrue_20260823_151111.zip`: ZIP integrity passed; size 3.5 MB.
- Shared Worker evidence: `shared-worker.js` attached via scoped `targetId`; `from=shared-worker` request, 200 response, and JSON response body all present.
- Other observed paths: Dedicated Worker, Service Worker, iframe/OOPIF request, WebSocket, SSE, DOM, IndexedDB, Cache Storage, screenshots, interactions, and runtime exception.
- Earlier 68 MB artifact was reduced to 3.5 MB by removing redundant timeline payload copies and explicitly excluding third-party extension artifacts.
- `WebCaptrue_20260823_152014.zip`: final export-stage redaction acceptance passed; ZIP integrity passed, 26 redactions were audited, no raw fixture password/token/key remained outside screenshots, and JavaScript remained syntactically structured with quoted `[REDACTED]` literals.

### Not Yet Run

- Windows 7 / Chrome 109 installation and end-to-end regression.
- Long-duration and large-session budgets, tab crash, debugger takeover, and service-worker restart recovery.
- The updated cross-origin fixture CORS-success branch was not rerun because restarting the local listener was blocked by the workspace approval-credit limit; the server file passes syntax validation and the previous run already captured the OOPIF request/failure path.

## Known Issues And Risks

- Current Chrome exports honestly report `known-gaps` when a worker bootstrap request has no terminal CDP event/body or a transient anonymous script disappears before `Debugger.getScriptSource`; these are not silently upgraded to complete.
- Screenshots are intentionally preserved as captured pixels and may display business-sensitive text; they are not OCR-redacted.
- The current-Chrome test proves the modern flat-session path plus scoped Shared Worker fallback, not Chrome 109 runtime behavior.

## Next Action

Run the same fixture and acceptance checklist on Windows 7 / Chrome 109. If no machine is available, next implement bounded session totals and a regression for worker-bootstrap request accounting without hiding genuine gaps.

## Important Files

- `src/background/00-core.js`: capture lifecycle helpers and Target discovery/attachment.
- `src/background/20-events.js`: CDP event routing and canonical network/runtime records.
- `src/lib/sanitize.js`: structure-preserving redaction helpers.
- `src/offscreen/00-analysis.js`: completeness verdict and gap accounting.
- `src/offscreen/10-export.js`: canonical ZIP layout and export-stage sanitization.
- `tests/e2e/`: local real-browser completeness fixture.
- `docs/PROJECT_PLAN.md`: roadmap and acceptance priorities.

## Blockers

- A Windows 7 VM or physical machine with Chrome 109 is required for the hard compatibility acceptance gate.
