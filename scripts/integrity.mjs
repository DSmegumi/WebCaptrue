import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const context = { self: {}, URL, URLSearchParams, atob, btoa, TextDecoder, TextEncoder };
context.self.self = context.self;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "src/lib/targets.js"), "utf8"), context, { filename: "targets.js" });

const targets = context.self.WebCaptrueTargets;
assert.ok(targets, "target compatibility helpers initialize");
assert.equal(targets.supportsFlatSessions("Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36"), true);
assert.equal(targets.supportsFlatSessions("Mozilla/5.0 Chrome/109.0.0.0 Safari/537.36"), false);

const scope = {
  rootTargetId: "root",
  rootTabId: 7,
  allowedOrigins: ["https://app.example.test"],
  allowedUrls: ["https://app.example.test/worker.js", "https://app.example.test/sw.js", "blob:https://app.example.test/abc"]
};
assert.equal(targets.isFallbackCandidate({ id: "worker-1", type: "worker", url: "https://app.example.test/worker.js" }, scope), true);
assert.equal(targets.isFallbackCandidate({ id: "sw-1", type: "service_worker", url: "https://app.example.test/sw.js" }, scope), true);
assert.equal(targets.isFallbackCandidate({ id: "blob-1", type: "worker", url: "blob:https://app.example.test/abc" }, scope), true);
assert.equal(targets.isFallbackCandidate({ id: "other", type: "worker", url: "https://other.example.test/worker.js" }, scope), false);
assert.equal(targets.isFallbackCandidate({ id: "same-origin-other-tab", type: "worker", url: "https://app.example.test/other-worker.js" }, scope), false);
assert.equal(targets.isFallbackCandidate({ id: "same-url-other-tab", type: "worker", tabId: 8, url: "https://app.example.test/worker.js" }, scope), false);
assert.equal(targets.isFallbackCandidate({ id: "root", type: "page", tabId: 7, url: "https://app.example.test/" }, scope), false);
assert.equal(targets.isBrowserExtensionUrl("chrome-extension://abc/content.js"), true);
assert.equal(targets.isBrowserExtensionUrl("https://app.example.test/app.js"), false);

vm.runInContext(fs.readFileSync(path.join(root, "src/lib/sanitize.js"), "utf8"), context, { filename: "sanitize.js" });
const sanitize = context.self.WebCaptrueSanitize;
const storageValue = JSON.parse(sanitize.storageValue("fixture", JSON.stringify({
  value: "keep",
  apiKey: "secret",
  nested: { token: "secret-2", count: 3 },
  rows: [{ id: 1, name: "keep-row" }]
})));
assert.deepEqual(JSON.parse(JSON.stringify(storageValue)), {
  value: "keep",
  apiKey: "[REDACTED]",
  nested: { token: "[REDACTED]", count: 3 },
  rows: [{ id: 1, name: "keep-row" }]
});
const redactionAudit = [];
assert.equal(sanitize.sourceText('const config = { apiKey: "secret", password: input.value };', redactionAudit, "$.source"), 'const config = { apiKey: "[REDACTED]", password: input.value };');
const structuredSnapshot = sanitize.domSnapshot({
  strings: ["INPUT", "type", "password", "secret-value", "{\"token\":\"secret\",\"rows\":[1]}"],
  documents: [{ nodes: { nodeName: [0], attributes: [[1, 2]], inputValue: { index: [0], value: [3] } } }]
}, redactionAudit, "$.snapshot");
assert.equal(structuredSnapshot.strings[3], "[REDACTED]");
assert.equal(structuredSnapshot.strings[4], '{"token":"[REDACTED]","rows":[1]}');
assert.ok(redactionAudit.length >= 3);
const sanitizedRecords = sanitize.exportRecords([
  { type: "domStructuredSnapshot", data: { snapshot: { strings: ["INPUT", "type", "password", "typed-secret"], documents: [{ nodes: { nodeName: [0], attributes: [[1, 2]], inputValue: { index: [0], value: [3] } } }] } } },
  { type: "scriptSource", data: { source: 'const injected = { text: "typed-secret", apiKey: "source-secret" };' } },
  { type: "preloadedResource", data: { resourceType: "Script", mimeType: "text/javascript", body: 'const config = { authorization: "Bearer secret" };' } }
]);
assert.equal(sanitizedRecords.records[1].data.source, 'const injected = { text: "[REDACTED]", apiKey: "[REDACTED]" };');
assert.equal(sanitizedRecords.records[2].data.body, 'const config = { authorization: "[REDACTED]" };');
const networkExport = sanitize.exportRecords([
  { type: "request", data: { headers: { authorization: "Bearer raw", "content-type": "application/json" }, postData: '{"password":"raw","rows":[1]}' } },
  { type: "responseBody", data: { mimeType: "application/json", base64Encoded: false, body: '{"token":"raw","rows":[1]}' } },
  { type: "clientStorageSnapshot", data: { snapshot: { localStorage: { fixture: '{"apiKey":"raw","rows":[1]}' } } } }
]);
assert.equal(networkExport.records[0].data.headers.authorization, "[REDACTED]");
assert.equal(networkExport.records[0].data.postData, '{"password":"[REDACTED]","rows":[1]}');
assert.equal(networkExport.records[1].data.body, '{"token":"[REDACTED]","rows":[1]}');
assert.equal(networkExport.records[2].data.snapshot.localStorage.fixture, '{"apiKey":"[REDACTED]","rows":[1]}');
const base64Export = sanitize.exportRecords([
  { type: "responseBody", data: { mimeType: "application/json", base64Encoded: true, body: btoa('{"password":"raw","rows":[1]}') } }
]);
assert.equal(atob(base64Export.records[0].data.body), '{"password":"[REDACTED]","rows":[1]}');

context.WebCaptrueDB = function () {};
context.setInterval = function () { return 0; };
context.chrome = { runtime: { sendMessage() {} } };
vm.runInContext(fs.readFileSync(path.join(root, "src/offscreen/00-analysis.js"), "utf8"), context, { filename: "00-analysis.js" });
const completeness = context.buildCompleteness({ completeness: { recordWriteFailures: 0, issues: [] } }, [
  { type: "request", data: { requestKey: "page|1", method: "GET", url: "https://app.example.test/api" } },
  { type: "targetAttachFailed", data: { targetId: "worker-1", type: "worker", reason: "attach failed" } },
  { type: "clientStorageSnapshotSkipped", data: { frameId: 2, reason: "content script unavailable" } }
]);
assert.equal(completeness.verdict, "known-gaps");
assert.deepEqual(Array.from(completeness.network.requestsWithoutTerminalEvent), ["page|1"]);
assert.equal(completeness.targets.attachFailures, 1);
assert.equal(completeness.storage.skippedFrames, 1);

const streamingCompleteness = context.buildCompleteness({
  options: { captureBodies: true },
  completeness: { recordWriteFailures: 0, issues: [] }
}, [
  { type: "request", data: { requestKey: "page|sse", method: "GET", resourceType: "EventSource", url: "https://app.example.test/events" } },
  { type: "response", data: { requestKey: "page|sse", status: 200, mimeType: "text/event-stream" } },
  { type: "eventSource", data: { payload: { requestId: "sse", eventName: "ready", data: "ok" } } },
  { type: "responseBodyExcluded", data: { requestKey: "page|ext", url: "chrome-extension://abc/content.js", reason: "browser extension artifact" } },
  { type: "request", data: { requestKey: "page|ext", method: "GET", resourceType: "Script", url: "chrome-extension://abc/content.js" } },
  { type: "response", data: { requestKey: "page|ext", status: 200, mimeType: "application/javascript" } }
]);
assert.equal(streamingCompleteness.verdict, "no-known-gaps");
assert.deepEqual(Array.from(streamingCompleteness.network.responsesWithoutBodyOrReason), []);
assert.equal(streamingCompleteness.exclusions.length, 1);

const issueCompleteness = context.buildCompleteness({
  options: { captureBodies: true },
  completeness: { recordWriteFailures: 0, issues: [{ code: "target-poll-failed" }] }
}, [{ type: "clientStorageTruncation", data: { issueCount: 1 } }]);
assert.equal(issueCompleteness.verdict, "known-gaps");
assert.equal(issueCompleteness.storage.truncationReports, 1);

console.log("WebCaptrue integrity checks passed: Chrome 109 fallback and scoped child Target selection OK.");
