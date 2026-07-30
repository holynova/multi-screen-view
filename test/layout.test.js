const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLayoutPlan, chooseWorkArea } = require("../layout.js");

const devices = [
  { id: "se", width: 375, height: 667, index: 0 },
  { id: "xr", width: 414, height: 896, index: 1 },
  { id: "pro", width: 402, height: 874, index: 2 },
  { id: "max", width: 440, height: 956, index: 3 }
];

test("places every phone on one 1440 by 900 work area without overlap", () => {
  const area = { left: 0, top: 25, width: 1440, height: 875 };
  const plan = buildLayoutPlan(devices, area);

  assert.equal(plan.windows.length, devices.length);
  assert.equal(plan.columns, 4);
  assert.ok(plan.scale > 0 && plan.scale < 1);
  assertInside(plan.windows, area);
  assertNoOverlap(plan.windows);
});

test("keeps the complete grid inside a secondary display with a negative origin", () => {
  const area = { left: -1920, top: -80, width: 1920, height: 1080 };
  const plan = buildLayoutPlan(devices, area);

  assert.equal(plan.scale, 1);
  assertInside(plan.windows, area);
  assertNoOverlap(plan.windows);
});

test("switches to a compact grid without requesting windows below Chrome minimums", () => {
  const area = { left: 0, top: 0, width: 820, height: 620 };
  const plan = buildLayoutPlan(devices, area);

  assert.equal(plan.columns, 2);
  assert.ok(plan.scale >= 0.25);
  assertInside(plan.windows, area);
  assertNoOverlap(plan.windows);
  plan.windows.forEach((window) => {
    assert.ok(window.width >= 240);
    assert.ok(window.height >= 180);
  });
});

test("reports an impossible layout instead of returning an unsupported zoom", () => {
  const plan = buildLayoutPlan(devices, { left: 0, top: 0, width: 640, height: 480 });

  assert.equal(plan.possible, false);
  assert.equal(plan.scale, 0.25);
  assert.deepEqual(plan.windows, []);
});

test("uses measured browser frame sizes when refining the layout", () => {
  const area = { left: 0, top: 0, width: 1440, height: 900 };
  const measured = devices.map((device, index) => ({
    ...device,
    frameWidth: 24 + index,
    frameHeight: 58 + index
  }));
  const plan = buildLayoutPlan(measured, area);

  assertInside(plan.windows, area);
  assertNoOverlap(plan.windows);
  plan.windows.forEach((window, index) => {
    assert.ok(window.width >= Math.round(devices[index].width * plan.scale) + 24 + index);
    assert.ok(window.height >= Math.round(devices[index].height * plan.scale) + 58 + index);
  });
});

test("chooses the display containing the center of the reference window", () => {
  const displays = [
    { isEnabled: true, workArea: { left: -1920, top: 0, width: 1920, height: 1050 } },
    { isEnabled: true, workArea: { left: 0, top: 25, width: 1440, height: 875 } }
  ];

  assert.deepEqual(
    chooseWorkArea(displays, { left: 100, top: 100, width: 900, height: 700 }),
    displays[1].workArea
  );
});

function assertInside(windows, area) {
  windows.forEach((window) => {
    assert.ok(window.left >= area.left);
    assert.ok(window.top >= area.top);
    assert.ok(window.left + window.width <= area.left + area.width);
    assert.ok(window.top + window.height <= area.top + area.height);
  });
}

function assertNoOverlap(windows) {
  for (let first = 0; first < windows.length; first += 1) {
    for (let second = first + 1; second < windows.length; second += 1) {
      const a = windows[first];
      const b = windows[second];
      const overlaps = a.left < b.left + b.width && a.left + a.width > b.left
        && a.top < b.top + b.height && a.top + a.height > b.top;
      assert.equal(overlaps, false, `${a.id} overlaps ${b.id}`);
    }
  }
}
