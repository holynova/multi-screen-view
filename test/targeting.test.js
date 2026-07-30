const test = require("node:test");
const assert = require("node:assert/strict");
const { findMatchingElement, normalizeText, scoreCandidate } = require("../targeting.js");

test("normalizes labels before comparing responsive copies", () => {
  assert.equal(normalizeText("  保存\n\t更改  "), "保存 更改");
});

test("prefers matching semantic identity over similar tag names", () => {
  const descriptor = {
    tag: "button",
    id: "",
    text: "加入购物车",
    classNames: ["primary-action"],
    attributes: { "data-testid": "add-to-cart", type: "button" }
  };
  const matching = {
    tag: "button",
    id: "",
    text: "加入购物车",
    classNames: ["primary-action", "mobile"],
    attributes: { "data-testid": "add-to-cart", type: "button" }
  };
  const unrelated = {
    tag: "button",
    id: "",
    text: "立即购买",
    classNames: ["primary-action"],
    attributes: { "data-testid": "buy-now", type: "button" }
  };

  assert.ok(scoreCandidate(descriptor, matching) > scoreCandidate(descriptor, unrelated));
  assert.ok(scoreCandidate(descriptor, matching) >= 20);
});

test("rejects a different element type even when its label matches", () => {
  const descriptor = { tag: "button", text: "继续", attributes: {}, classNames: [] };
  const candidate = { tag: "a", text: "继续", attributes: {}, classNames: [] };

  assert.equal(scoreCandidate(descriptor, candidate), -Infinity);
});

test("does not accept role or type as the only evidence", () => {
  const descriptor = {
    tag: "button",
    id: "",
    text: "",
    classNames: [],
    attributes: { type: "button" },
    selectors: [{ kind: "attribute", value: 'button[type="button"]' }]
  };
  const candidate = fakeElement({ tag: "button", attributes: { type: "button" } });
  const root = { querySelectorAll: () => [candidate] };

  assert.equal(findMatchingElement(descriptor, root), null);
});

test("does not guess when two candidates have equal evidence", () => {
  const descriptor = {
    tag: "button",
    id: "",
    text: "删除",
    classNames: [],
    attributes: {},
    selectors: []
  };
  const root = {
    querySelectorAll: () => [
      fakeElement({ tag: "button", text: "删除" }),
      fakeElement({ tag: "button", text: "删除" })
    ]
  };

  assert.equal(findMatchingElement(descriptor, root), null);
});

function fakeElement({ tag, text = "", id = "", attributes = {} }) {
  return {
    tagName: tag.toUpperCase(),
    innerText: text,
    id,
    classList: [],
    getAttribute(name) {
      return attributes[name] || null;
    }
  };
}
