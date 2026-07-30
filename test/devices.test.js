const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCustomDevice,
  normalizeSelection,
  sanitizeCustomDevices
} = require("../devices.js");

test("creates a named custom device and rounds dimensions", () => {
  assert.deepEqual(
    createCustomDevice({ label: "  产品详情页  ", width: 389.6, height: 844.4 }, "custom-product"),
    {
      id: "custom-product",
      label: "产品详情页",
      note: "自定义尺寸",
      width: 390,
      height: 844,
      enabled: true,
      custom: true
    }
  );
});

test("uses the dimensions when the custom name is empty", () => {
  const device = createCustomDevice({ width: 768, height: 1024 }, "custom-tablet");
  assert.equal(device.label, "768 × 1024");
});

test("rejects unsupported dimensions", () => {
  assert.throws(
    () => createCustomDevice({ width: 120, height: 900 }, "custom-too-small"),
    /宽度需在/
  );
  assert.throws(
    () => createCustomDevice({ width: 400, height: 3000 }, "custom-too-tall"),
    /高度需在/
  );
});

test("drops malformed and duplicate stored devices", () => {
  const devices = sanitizeCustomDevices([
    { id: "custom-one", label: "One", width: 390, height: 844 },
    { id: "custom-one", label: "Duplicate", width: 430, height: 932 },
    { id: "unsafe", label: "Bad ID", width: 390, height: 844 },
    { id: "custom-bad", label: "Bad size", width: 50, height: 50 }
  ]);

  assert.equal(devices.length, 1);
  assert.equal(devices[0].label, "One");
});

test("preserves whether a saved custom device is enabled", () => {
  const [device] = sanitizeCustomDevices([
    { id: "custom-saved", label: "Saved", width: 390, height: 844, enabled: false }
  ]);

  assert.equal(device.enabled, false);
});

test("moves the master to the first enabled device", () => {
  const selection = normalizeSelection(
    [{ id: "one" }, { id: "two" }],
    ["two"],
    "one",
    8
  );

  assert.deepEqual(selection, { selectedIds: ["two"], masterId: "two" });
});

test("filters missing devices and caps the enabled selection", () => {
  const devices = Array.from({ length: 10 }, (_, index) => ({ id: `device-${index}` }));
  const selection = normalizeSelection(
    devices,
    ["missing", ...devices.map((device) => device.id)],
    "device-9",
    8
  );

  assert.equal(selection.selectedIds.length, 8);
  assert.equal(selection.masterId, "device-0");
});
