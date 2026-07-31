import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

assert.equal(manifest.manifest_version, 3, "Manifest must use MV3");
assert.equal(manifest.version, packageJson.version, "Manifest and package versions must match");
assert.ok(manifest.description.length <= 132, "Manifest description must not exceed 132 characters");
assert.deepEqual([...manifest.permissions].sort(), ["storage", "system.display", "windows"].sort());
assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
assert.deepEqual(manifest.icons, {
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png"
});

const requiredImages = new Map([
  ["icons/icon16.png", [16, 16]],
  ["icons/icon32.png", [32, 32]],
  ["icons/icon48.png", [48, 48]],
  ["icons/icon128.png", [128, 128]],
  ["store-assets/store-icon-128.png", [128, 128]],
  ["store-assets/small-promo-440x280.png", [440, 280]],
  ["store-assets/marquee-1400x560.png", [1400, 560]],
  ["store-assets/screenshots/01-launcher-1280x800.png", [1280, 800]],
  ["store-assets/screenshots/02-custom-sizes-1280x800.png", [1280, 800]],
  ["store-assets/screenshots/03-session-controls-1280x800.png", [1280, 800]],
  ["store-assets/screenshots/04-multi-window-sync-1280x800.png", [1280, 800]]
]);

for (const [relativePath, expectedDimensions] of requiredImages) {
  const file = await readFile(resolve(root, relativePath));
  assert.equal(file.subarray(1, 4).toString(), "PNG", `${relativePath} must be PNG`);
  const actual = [file.readUInt32BE(16), file.readUInt32BE(20)];
  assert.deepEqual(actual, expectedDimensions, `${relativePath} must be ${expectedDimensions.join("x")}`);
}

for (const [relativePath, targetDimensions] of [
  ["store-assets/captures/actual-master.png", [804, 1748]],
  ["store-assets/captures/actual-follower.png", [750, 1334]]
]) {
  const file = await readFile(resolve(root, relativePath));
  assert.equal(file.subarray(1, 4).toString(), "PNG", `${relativePath} must be PNG`);
  const actual = [file.readUInt32BE(16), file.readUInt32BE(20)];
  assert.ok(
    actual.every((value, index) => Math.abs(value - targetDimensions[index]) <= 4),
    `${relativePath} must preserve the calibrated device viewport near ${targetDimensions.join("x")}`
  );
}

for (const relativePath of [
  "privacy.html",
  "store-listing/zh-CN.md",
  "store-listing/en.md",
  "store-listing/submission-checklist.md"
]) {
  assert.ok((await stat(resolve(root, relativePath))).size > 100, `${relativePath} is missing or empty`);
}

const privacy = await readFile(resolve(root, "privacy.html"), "utf8");
for (const phrase of ["URL", "滚动位置", "点击位置", "不会发送给开发者", "Limited Use"]) {
  assert.ok(privacy.includes(phrase), `Privacy policy must disclose: ${phrase}`);
}

console.log(`Store package validation passed for Viewport Relay ${manifest.version}.`);
