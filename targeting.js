(function exposeViewportRelayTargeting(globalScope) {
  const INTERACTIVE_SELECTOR = [
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "label",
    "[role='button']",
    "[role='link']",
    "[onclick]"
  ].join(", ");
  const ATTRIBUTE_WEIGHTS = {
    "data-testid": 12,
    "data-test": 11,
    "data-cy": 11,
    name: 9,
    "aria-label": 9,
    href: 8,
    role: 6,
    type: 4
  };
  const MIN_MATCH_SCORE = 9;

  function describeElement(element, root = globalScope.document) {
    if (!element || element.nodeType !== 1 || !root) return null;
    const target = element.closest?.(INTERACTIVE_SELECTOR);
    if (!target) return null;
    const snapshot = snapshotElement(target);
    const selectors = [];

    if (snapshot.id) {
      selectors.push({ kind: "identity", value: `#${escapeIdentifier(snapshot.id)}` });
    }

    Object.keys(ATTRIBUTE_WEIGHTS).forEach((attribute) => {
      const value = snapshot.attributes[attribute];
      if (!value) return;
      selectors.push({
        kind: "attribute",
        value: `${snapshot.tag}[${attribute}="${escapeAttribute(value)}"]`
      });
    });

    const structural = structuralSelector(target);
    if (structural) selectors.push({ kind: "structural", value: structural });

    return {
      version: 1,
      selectors: uniqueSelectors(selectors).slice(0, 10),
      ...snapshot
    };
  }

  function findMatchingElement(descriptor, root = globalScope.document) {
    if (!descriptor || !root) return null;

    for (const selector of descriptor.selectors || []) {
      const matches = safeQueryAll(root, selector.value).slice(0, 100);
      const winner = bestMatch(descriptor, matches);
      if (winner && winner.score >= MIN_MATCH_SCORE) return winner.element;
    }

    const pool = safeQueryAll(root, safeTag(descriptor.tag)).slice(0, 1000);
    const winner = bestMatch(descriptor, pool);
    return winner && winner.score >= MIN_MATCH_SCORE ? winner.element : null;
  }

  function scoreCandidate(descriptor, candidate) {
    if (!descriptor || !candidate || safeTag(descriptor.tag) !== safeTag(candidate.tag)) return -Infinity;
    let score = 1;

    if (descriptor.id && candidate.id === descriptor.id) score += 14;
    Object.entries(ATTRIBUTE_WEIGHTS).forEach(([attribute, weight]) => {
      const expected = descriptor.attributes?.[attribute];
      if (expected && candidate.attributes?.[attribute] === expected) score += weight;
    });

    const expectedText = normalizeText(descriptor.text);
    const candidateText = normalizeText(candidate.text);
    if (expectedText && candidateText) {
      if (expectedText === candidateText) score += 8;
      else if (expectedText.length >= 4 && (
        expectedText.includes(candidateText) || candidateText.includes(expectedText)
      )) score += 3;
    }

    const expectedClasses = new Set(descriptor.classNames || []);
    (candidate.classNames || []).forEach((className) => {
      if (expectedClasses.has(className)) score += 1;
    });
    return score;
  }

  function bestMatch(descriptor, elements) {
    let winner = null;
    let hasTie = false;
    elements.forEach((element) => {
      const score = scoreCandidate(descriptor, snapshotElement(element));
      if (!winner || score > winner.score) {
        winner = { element, score };
        hasTie = false;
      } else if (score === winner.score) {
        hasTie = true;
      }
    });
    return hasTie ? null : winner;
  }

  function snapshotElement(element) {
    const attributes = {};
    Object.keys(ATTRIBUTE_WEIGHTS).forEach((attribute) => {
      const rawValue = element.getAttribute?.(attribute);
      const value = attribute === "href"
        ? normalizeHref(rawValue)
        : cleanValue(rawValue, 200);
      if (value) attributes[attribute] = value;
    });

    return {
      tag: safeTag(element.tagName),
      id: cleanValue(element.id, 160),
      text: normalizeText(element.innerText || element.textContent).slice(0, 160),
      classNames: Array.from(element.classList || []).filter(isStableClass).slice(0, 6),
      attributes
    };
  }

  function structuralSelector(element) {
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === 1 && depth < 7; depth += 1) {
      const tag = safeTag(current.tagName);
      if (!tag) break;
      if (current.id) {
        parts.unshift(`#${escapeIdentifier(current.id)}`);
        break;
      }

      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children || []).filter((child) => safeTag(child.tagName) === tag);
      const position = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${Math.max(position, 1)})`);
      current = parent;
    }
    return parts.join(" > ").slice(0, 500);
  }

  function safeQueryAll(root, selector) {
    if (!selector || typeof selector !== "string" || selector.length > 500) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function safeTag(value) {
    const tag = String(value || "").toLowerCase();
    return /^[a-z][a-z0-9-]*$/.test(tag) ? tag : "*";
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function cleanValue(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
  }

  function normalizeHref(value) {
    const cleaned = cleanValue(value, 500);
    if (!cleaned) return "";
    try {
      const base = globalScope.location?.href || "https://viewport-relay.invalid/";
      const url = new URL(cleaned, base);
      return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : "";
    } catch {
      return "";
    }
  }

  function isStableClass(className) {
    return /^[a-zA-Z_-][\w-]{0,63}$/.test(className) && !/\d{5,}/.test(className);
  }

  function uniqueSelectors(selectors) {
    const seen = new Set();
    return selectors.filter((selector) => {
      if (!selector.value || seen.has(selector.value)) return false;
      seen.add(selector.value);
      return true;
    });
  }

  function escapeIdentifier(value) {
    if (globalScope.CSS?.escape) return globalScope.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0).toString(16)} `);
  }

  function escapeAttribute(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, "\\\"")
      .replace(/[\n\r\f]/g, " ");
  }

  const api = { describeElement, findMatchingElement, normalizeText, scoreCandidate };
  globalScope.ViewportRelayTargeting = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
