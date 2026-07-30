const RELAY_BADGE_ID = "__viewport-relay-badge";
const CLICK_MARKER_ID = "__viewport-relay-click";

let role = "idle";
let scrollFrame = null;
let lastScrollSentAt = 0;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "set-role") {
    role = message.role;
    renderRoleBadge(message);
    return;
  }

  if (message.type === "report-viewport") {
    reportViewport(0);
    return;
  }

  if (message.type === "apply-scroll") {
    window.scrollTo({ left: message.x, top: message.y, behavior: "auto" });
    return;
  }

  if (message.type === "apply-click") {
    replayClick(message.xRatio, message.yRatio);
  }
});

window.addEventListener("scroll", () => {
  if (role !== "master" || scrollFrame) return;

  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    const now = performance.now();
    if (now - lastScrollSentAt < 24) return;
    lastScrollSentAt = now;

    chrome.runtime.sendMessage({
      type: "master-scroll",
      x: window.scrollX,
      y: window.scrollY
    }).catch(() => {});
  });
}, { passive: true });

document.addEventListener("click", (event) => {
  if (role !== "master" || event.button !== 0) return;

  const xRatio = clamp(event.clientX / Math.max(window.innerWidth, 1), 0, 1);
  const yRatio = clamp(event.clientY / Math.max(window.innerHeight, 1), 0, 1);
  showClickMarker(event.clientX, event.clientY);

  chrome.runtime.sendMessage({
    type: "master-click",
    xRatio,
    yRatio
  }).catch(() => {});
}, true);

window.addEventListener("resize", debounce(() => reportViewport(0), 120));
reportViewport(0);

function reportViewport(attempt = 0) {
  chrome.runtime.sendMessage({
    type: "pane-ready",
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  }).then((response) => {
    if (!response?.registered && attempt < 5) {
      setTimeout(() => reportViewport(attempt + 1), 160 * (attempt + 1));
    }
  }).catch(() => {
    if (attempt < 5) {
      setTimeout(() => reportViewport(attempt + 1), 160 * (attempt + 1));
    }
  });
}

function replayClick(xRatio, yRatio) {
  const x = clamp(xRatio, 0, 1) * window.innerWidth;
  const y = clamp(yRatio, 0, 1) * window.innerHeight;
  const rawTarget = document.elementFromPoint(x, y);
  const target = rawTarget?.closest?.("a, button, input, select, textarea, summary, [role='button'], [onclick]") || rawTarget;

  showClickMarker(x, y);
  if (!target) return;

  if (typeof target.focus === "function") {
    target.focus({ preventScroll: true });
  }

  if (typeof target.click === "function") {
    target.click();
    return;
  }

  target.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    view: window
  }));
}

function renderRoleBadge(config) {
  document.getElementById(RELAY_BADGE_ID)?.remove();
  if (config.role !== "master") return;

  const badge = document.createElement("div");
  badge.id = RELAY_BADGE_ID;
  badge.textContent = `主屏 · ${config.targetWidth}×${config.targetHeight}`;
  Object.assign(badge.style, {
    position: "fixed",
    top: "10px",
    right: "10px",
    zIndex: "2147483647",
    pointerEvents: "none",
    padding: "7px 10px",
    borderRadius: "6px",
    background: "rgba(28, 25, 23, 0.92)",
    color: "rgba(255, 255, 255, 0.92)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.18)",
    font: "600 12px/1.2 -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
    letterSpacing: "0.01em"
  });
  document.documentElement.appendChild(badge);
}

function showClickMarker(x, y) {
  document.getElementById(CLICK_MARKER_ID)?.remove();
  const marker = document.createElement("div");
  marker.id = CLICK_MARKER_ID;
  Object.assign(marker.style, {
    position: "fixed",
    left: `${x}px`,
    top: `${y}px`,
    width: "22px",
    height: "22px",
    zIndex: "2147483646",
    pointerEvents: "none",
    border: "2px solid rgb(225, 74, 42)",
    borderRadius: "999px",
    transform: "translate(-50%, -50%) scale(0.45)",
    opacity: "0.9",
    transition: "transform 240ms cubic-bezier(0.16, 1, 0.3, 1), opacity 240ms ease-out"
  });
  document.documentElement.appendChild(marker);

  requestAnimationFrame(() => {
    marker.style.transform = "translate(-50%, -50%) scale(1.25)";
    marker.style.opacity = "0";
  });

  setTimeout(() => marker.remove(), 280);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function debounce(callback, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), delay);
  };
}
