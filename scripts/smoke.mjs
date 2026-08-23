import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(root, "src/lib/zip.js"), "utf8"), { filename: "zip.js" });

if (!globalThis.WebCaptrueZip?.createZip) throw new Error("ZIP exporter did not initialize");
const blob = globalThis.WebCaptrueZip.createZip([
  { path: "ai/summary.json", data: JSON.stringify({ ok: true }) },
  { path: "network/session.har", data: "{}" },
  { path: "resources/binary.bin", data: new Uint8Array([0, 1, 2, 255]) }
]);
const bytes = new Uint8Array(await blob.arrayBuffer());
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getUint32(0, true) !== 0x04034b50) throw new Error("ZIP local header signature missing");
if (view.getUint32(bytes.length - 22, true) !== 0x06054b50) throw new Error("ZIP EOCD signature missing");

const background = ["src/background.js", "src/background/00-core.js", "src/background/10-capture.js", "src/background/20-events.js"].map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
const content = fs.readFileSync(path.join(root, "src/content.js"), "utf8");
const offscreen = ["src/offscreen.js", "src/offscreen/00-analysis.js", "src/offscreen/10-export.js"].map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
for (const marker of ["Target.setDiscoverTargets", "targetId", "captureFullPageScreenshot", "interactionId", "requestKey"]) {
  if (!background.includes(marker)) throw new Error(`background capture marker missing: ${marker}`);
}
for (const marker of ["indexedDB.databases", "dumpCacheStorage", "REQUEST_CLIENT_STORAGE"]) {
  if (!content.includes(marker)) throw new Error(`client storage marker missing: ${marker}`);
}
if (!content.includes("event.isTrusted") || !content.includes("TOGGLE_CAPTURE_FROM_PAGE") || !background.includes("TOGGLE_CAPTURE_FROM_PAGE")) {
  throw new Error("trusted capture shortcut path missing");
}
for (const marker of ["ai/summary.json", "ai/workflow.json", "api/api-index.json", "integrity/completeness.json", "buildApiIndex", "buildWorkflow", "buildCompleteness"]) {
  if (!offscreen.includes(marker)) throw new Error(`AI export marker missing: ${marker}`);
}

console.log("WebCaptrue smoke checks passed: ZIP writer and v0.2 capture/export markers OK.");
