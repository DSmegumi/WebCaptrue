import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const errors = [];
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== packageJson.version) errors.push("manifest.json and package.json versions must match");

if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
if (String(manifest.minimum_chrome_version) !== "109") errors.push("minimum_chrome_version must remain 109");
if (!manifest.commands || !manifest.commands["toggle-capture"]) errors.push("missing toggle-capture keyboard command");
for (const permission of ["debugger", "downloads", "offscreen", "storage", "tabs", "webNavigation"]) {
  if (!manifest.permissions.includes(permission)) errors.push(`missing permission: ${permission}`);
}

const required = [
  "popup.html", "popup.css", "popup.js", "offscreen.html",
  "src/background.js", "src/background/00-core.js", "src/background/10-capture.js", "src/background/20-events.js",
  "src/content.js", "src/offscreen.js", "src/offscreen/00-analysis.js", "src/offscreen/10-export.js",
  "src/lib/db.js", "src/lib/sanitize.js", "src/lib/targets.js", "src/lib/zip.js", "AGENTS.md", "README.md", "docs/PROJECT_PLAN.md", "scripts/integrity.mjs", "scripts/smoke.mjs"
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`missing file: ${file}`);
}

const jsFiles = ["popup.js", "src/background.js", "src/background/00-core.js", "src/background/10-capture.js", "src/background/20-events.js", "src/content.js", "src/offscreen.js", "src/offscreen/00-analysis.js", "src/offscreen/10-export.js", "src/lib/db.js", "src/lib/sanitize.js", "src/lib/targets.js", "src/lib/zip.js"];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "pipe" });
  } catch (error) {
    errors.push(`syntax error in ${file}: ${error.stderr?.toString() || error.message}`);
  }
}

const allText = required.concat(["manifest.json"]).filter(f => fs.existsSync(path.join(root, f))).map(f => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
for (const banned of ["chrome.sidePanel", "chrome.runtime.getContexts", "action.isEnabled("]) {
  if (allText.includes(banned)) errors.push(`Chrome >109 API detected: ${banned}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("WebCaptrue validation passed: Manifest V3, Chrome 109 baseline, required files and JS syntax OK.");
