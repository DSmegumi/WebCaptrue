# Project State

## Last Updated

2026-08-24

## Current Objective

Protect capture completeness and structural fidelity first, then apply auditable export-time redaction, while preserving the Chrome 109 / Windows 7 baseline.

## Current State

The extension now completes real start/stop/export flows in macOS Chrome 151. A local E2E fixture exercises page, iframe, cross-origin iframe, Dedicated Worker, pre-existing Shared Worker, Service Worker, Fetch, WebSocket, SSE, DOM, storage, screenshots, interaction, and exception paths. The latest safe-attribution export reports the unresolved browser evidence as `known-gaps` instead of mis-associating it. Version 0.2.2 adds offline per-session environment and runtime diagnostics to capture format v3; automated archive, syntax, compatibility, and redaction checks pass, while a post-reload Chrome ZIP run is still pending. The signed CRX is published and verified on GitHub. The hard Windows 7 / Chrome 109 acceptance gate remains untested.

## Completed Work

- Added Chrome-version-aware child Target capture: flat sessions on Chrome 125+ and scoped `targetId` polling fallback for Chrome 109.
- Added a global Target sweep so a Shared Worker that existed before capture is detected; it is attached only when its exact URL was observed from the captured page, otherwise it remains an explicit attribution gap.
- Requires no-`tabId` fallback Targets to have an observed exact URL and an unambiguous origin; same-origin alone is not accepted as ownership evidence.
- Records an unobserved same-origin no-`tabId` Target as an attribution gap instead of silently attaching it or silently omitting the candidate.
- Treats unsupported `Target.setDiscoverTargets` / `Target.getTargets` calls as audited fallback usage when `chrome.debugger.getTargets` and auto-attach remain available, instead of reporting a false data gap.
- Added explicit completeness output: `integrity/completeness.json`, failures, truncations, exclusions, and export-stage redaction audit.
- Preserved redirect chains with generation-qualified request keys so reused CDP request IDs no longer overwrite earlier hops.
- Serialized debugger events per source and defers ExtraInfo association until all redirect hops are known; ambiguous/missing ExtraInfo is retained with candidates and an explicit completeness issue instead of being mislinked.
- Added stop-time debugger quiet, event, and database-write drains before the final session marker and export; child Target mappings remain valid through the tail-event window.
- Changed network and client-storage capture to retain the browser-exposed raw structure in the local session; credential redaction now happens on the export copy.
- Added explicit client-storage truncation/error records and included runtime issues in the `known-gaps` verdict.
- Narrowed fallback attachment for workers, Shared Workers, Service Workers, and iframes to URLs actually observed from the captured page.
- Refreshes observed resource and Service Worker script URLs during capture; explicitly rejects Targets carrying another tab ID even when URL matches.
- Captures each input event immediately (without recording field values), avoiding loss of the last input during stop.
- Redacts UTF-8 text MIME bodies even when CDP supplied them as base64; non-UTF-8 bytes remain bit-for-bit unchanged with an explicit redaction-skip audit.
- Added idempotent content-script injection so capture can start on an already-open page.
- Added click-operable popup flow plus `Ctrl+Shift+Y` command/page bridge.
- Preserved JSON-string storage structure while redacting sensitive field values only in the exported copy.
- Excluded third-party `chrome-extension://` bodies and sources from webpage artifacts while retaining metadata and an explicit exclusion record.
- Removed large payload duplication from `timeline.jsonl`; the equivalent data remains in its canonical archive directory.
- Added a persistent two-origin E2E fixture covering Fetch GET/POST, iframe/OOPIF, Dedicated/Shared/Service Worker, WebSocket, SSE, IndexedDB, Cache Storage, SPA navigation, and exceptions.
- Added integrity regression tests for Chrome 109 routing, target scoping, redirect/drain implementation markers, raw-to-export network/storage redaction, SSE completeness, exclusions, source-code structural redaction, and structured DOM password redaction.
- Rebuilt the signed CRX as 0.2.1 from the current runtime files, verified its ZIP contents byte-for-byte against the packaging directory, and changed Release automation to verify a repository-contained signed asset instead of an expiring OneDrive URL.
- Added versioned `diagnostics/environment.json` and `diagnostics/runtime-log.jsonl` output with browser/OS context, lifecycle milestones, capture failures, compatibility gaps, and export-time credential redaction; no logs are uploaded automatically.
- Added bounded diagnostic entry/detail budgets with explicit truncation reporting, error stacks, global service-worker error/rejection capture, and automatic `_interrupted` ZIP recovery for debugger detach, tab close, startup failure where export remains available, and service-worker restart.

## Validation Status

### Completed

- `npm test`: passed manifest/API baseline, syntax, integrity, ZIP, and smoke checks.
- `git diff --check`: passed.
- `WebCaptrue-0.2.1.crx`: CRX3/ZIP integrity passed; 38,964 bytes; SHA-256 `f6faf5f8759d7fca6544b014b61c768c42c383c442872e65ebf1f0cbdc3b1462`; extracted files matched the packaging directory.
- `WebCaptrue-0.2.2.crx`: CRX3/ZIP integrity passed; 42,648 bytes; SHA-256 `0a80cc11750538e1dc96e49481b6d67086cd6032b2e199ea47193b271120c345`; extracted files matched the packaging directory.
- GitHub `validate #23` and `Release CRX #5` passed for commit `e5e51c8`; Release `v0.2.2` points to that commit and publishes the same verified CRX digest.
- GitHub `validate #21` and `Release CRX #4` passed for commit `89723f3`; Release `v0.2.1` points to that commit and publishes the same verified CRX digest.
- Diagnostic builder, environment detection, failure aggregation, sensitive-field redaction, archive-path smoke checks, manifest/API validation, and JavaScript syntax checks pass locally.
- Post-review regressions passed for scoped child targets, raw-to-export request/body/storage redaction, storage truncation accounting, runtime-issue verdicts, redirect handling, and stop-time event draining.
- Final-review regressions passed for cross-tab rejection and base64 JSON redaction; key Target discovery failures are now explicit completeness issues rather than silent empty results.
- Real Chrome 151 popup automation: actual toolbar icon → start → interactions → stop → ZIP download completed.
- `WebCaptrue_20260823_151111.zip`: ZIP integrity passed; size 3.5 MB.
- Shared Worker evidence: `shared-worker.js` attached via scoped `targetId`; `from=shared-worker` request, 200 response, and JSON response body all present.
- Other observed paths: Dedicated Worker, Service Worker, iframe/OOPIF request, WebSocket, SSE, DOM, IndexedDB, Cache Storage, screenshots, interactions, and runtime exception.
- Earlier 68 MB artifact was reduced to 3.5 MB by removing redundant timeline payload copies and explicitly excluding third-party extension artifacts.
- `WebCaptrue_20260823_152014.zip`: final export-stage redaction acceptance passed; ZIP integrity passed, 26 redactions were audited, no raw fixture password/token/key remained outside screenshots, and JavaScript remained syntactically structured with quoted `[REDACTED]` literals.
- `WebCaptrue_20260824_002823.zip`: automated toolbar start/stop and ZIP integrity passed in Chrome 151. Its initial `no-known-gaps` verdict was invalidated during review because cross-Target ExtraInfo had been associated using a raw CDP request ID; that unsafe association was removed.
- The invalidated `002823` export contains 19 requests, 20 responses, 17 response bodies, all three worker paths (Dedicated/Shared/Service Worker), the complete 302 → 307 → 200 redirect chain, four WebSocket lifecycle/frame events, six storage snapshots, six screenshots, eleven interactions, one exception, and 68 audited export-time redactions; it is retained only as debugging evidence, not acceptance evidence.
- A plaintext scan of all non-screenshot export files found none of the fixture password/token/key values. Screenshots remain intentionally raw pixels.
- `WebCaptrue_20260824_003920.zip`: post-review safe-attribution export passed ZIP integrity and automatic toolbar start/stop. It captured 12 requests, 13 responses, 9 bodies, the 302 → 307 → 200 redirect chain, Dedicated Worker, Service Worker, iframe/OOPIF, WebSocket, six storage snapshots, six screenshots, eleven interactions, and 66 audited redactions. Verdict is honestly `known-gaps`: one unproven pre-existing Shared Worker candidate, one unrecoverable pre-capture response body, and one root/Service-Worker ExtraInfo pair whose cross-Target association cannot be proven.

### Not Yet Run

- Windows 7 / Chrome 109 installation and end-to-end regression.
- Post-reload Chrome 151 start/stop/export verification of the new diagnostics files.
- Long-duration and large-session budgets, tab crash, debugger takeover, and service-worker restart recovery.
- Safe ownership proof for a pre-existing Shared Worker whose script URL is not exposed in the page's resource timing data.
- Safe cross-Target correlation for ExtraInfo that Chrome delivers on the root debugger source while the request/response events arrive on a child session.

## Known Issues And Risks

- `no-known-gaps` means the implemented checks found no missing datum in the exercised fixture; it is not proof that Chrome exposed every possible datum.
- The latest safe run remains `known-gaps`; raw CDP request IDs are never used alone to bridge root and child-session ExtraInfo.
- Capture limits are now explicit per item, but a total long-session byte budget and stress acceptance are still pending.
- Screenshots are intentionally preserved as captured pixels and may display business-sensitive text; they are not OCR-redacted.
- The current-Chrome test proves the modern flat-session path plus scoped Shared Worker fallback, not Chrome 109 runtime behavior.

## Next Action

Reload the unpacked extension in Chrome 151 and verify a real exported ZIP contains usable, redacted diagnostics alongside the network data. Without a Windows 7 machine, then retain explicit compatibility gaps and continue bounded-session stress work.

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
