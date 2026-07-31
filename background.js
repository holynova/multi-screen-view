importScripts("layout.js");

const SESSION_KEY = "viewportRelaySession";
const LAUNCHER_PATH = "index.html";
const WINDOW_GAP = 14;
const WINDOW_CHROME_WIDTH = 16;
const WINDOW_CHROME_HEIGHT = 46;
const WINDOW_MARGIN = 16;
const MAX_DEVICE_COUNT = 8;
const CONTROL_MESSAGES = new Set([
  "launch-session",
  "close-session",
  "arrange-session",
  "get-session",
  "set-click-mode",
  "focus-master",
  "reload-session",
  "toggle-sync"
]);
const TARGET_ATTRIBUTES = new Set([
  "data-testid",
  "data-test",
  "data-cy",
  "name",
  "aria-label",
  "href",
  "role",
  "type"
]);
let calibrationQueue = Promise.resolve();

chrome.action.onClicked.addListener(openLauncher);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (CONTROL_MESSAGES.has(message.type) && !isLauncherSender(sender)) {
    sendResponse({ ok: false, error: "此操作只能从扩展启动页发起" });
    return false;
  }

  if (message.type === "launch-session") {
    enqueueSessionOperation(() => launchSession(message.payload, sender.tab?.windowId))
      .then((session) => sendResponse({ ok: true, session: publicSession(session) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "close-session") {
    enqueueSessionOperation(closeSession)
      .then((session) => sendResponse({ ok: true, session: publicSession(session) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "arrange-session") {
    const arrangement = enqueueSessionOperation(() => arrangeSession(sender.tab?.windowId));
    arrangement
      .then((session) => sendResponse({ ok: true, session: publicSession(session) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "get-session") {
    getSession().then((session) => sendResponse({ ok: true, session: publicSession(session) }));
    return true;
  }

  if (message.type === "set-click-mode") {
    const modeUpdate = enqueueSessionOperation(() => setClickMode(message.clickMode));
    modeUpdate
      .then((session) => sendResponse({ ok: true, session: publicSession(session) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "focus-master") {
    focusMaster()
      .then((session) => sendResponse({ ok: true, session: publicSession(session) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "reload-session" || message.type === "toggle-sync") {
    const action = enqueueSessionOperation(() => (
      message.type === "reload-session" ? reloadSession() : toggleSync()
    ));
    action
      .then((session) => sendResponse({ ok: true, session: publicSession(session) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "pane-ready" && sender.tab?.id) {
    enqueueSessionOperation(() => configurePane(sender.tab.id, message.viewport, message.layoutGeneration))
      .then((registered) => sendResponse({ registered }))
      .catch(() => sendResponse({ registered: false }));
    return true;
  }

  if ((message.type === "master-scroll" || message.type === "master-click") && sender.tab?.id) {
    relayMasterEvent(sender.tab.id, message).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    enqueueSessionOperation(() => syncMasterNavigation(tabId, changeInfo.url)).catch(() => {});
  }
  if (changeInfo.status === "complete") {
    enqueueSessionOperation(() => requestPaneViewport(tabId)).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueSessionOperation(() => removePane(tabId)).catch(() => {});
});

function enqueueSessionOperation(operation) {
  const action = calibrationQueue.then(operation);
  calibrationQueue = action.catch(() => {});
  return action;
}

async function openLauncher() {
  const launcherUrl = chrome.runtime.getURL(LAUNCHER_PATH);
  const existing = await chrome.tabs.query({ url: launcherUrl });

  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: launcherUrl });
}

async function launchSession(payload = {}, anchorWindowId) {
  const url = normalizeUrl(payload.url);
  const devices = normalizeDevices(payload.devices);
  const clickMode = normalizeClickMode(payload.clickMode);

  if (!devices.length) {
    throw new Error("请至少选择一个屏幕尺寸");
  }

  await closeSession();

  const anchorWindow = Number.isInteger(anchorWindowId)
    ? await chrome.windows.get(anchorWindowId)
    : await chrome.windows.getCurrent();
  const workArea = await getWorkArea(anchorWindow);
  const panes = {};
  const createdWindowIds = [];
  const layout = createLayout(devices, workArea);
  assertLayoutPossible(layout);

  try {
    for (const [index, device] of devices.entries()) {
      const bounds = layout.windows.find((windowLayout) => windowLayout.index === index);

      const created = await chrome.windows.create({
        url,
        type: "popup",
        focused: false,
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height
      });

      const tabId = created.tabs?.[0]?.id;
      if (!tabId) {
        throw new Error(`无法创建 ${device.label} 窗口`);
      }

      await chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
      await chrome.tabs.setZoom(tabId, layout.scale);

      createdWindowIds.push(created.id);
      panes[String(tabId)] = {
        tabId,
        windowId: created.id,
        label: device.label,
        targetWidth: device.width,
        targetHeight: device.height,
        displayScale: layout.scale,
        calibrated: false,
        calibrationAttempts: 0,
        index
      };

    }
  } catch (error) {
    await Promise.all(createdWindowIds.map((windowId) => chrome.windows.remove(windowId).catch(() => {})));
    await setSession(emptySession());
    throw error;
  }

  const requestedMaster = devices.findIndex((device) => device.id === payload.masterId);
  const masterIndex = requestedMaster >= 0 ? requestedMaster : 0;
  const masterPane = Object.values(panes).find((pane) => pane.index === masterIndex);
  const session = {
    active: true,
    url,
    masterTabId: masterPane.tabId,
    panes,
    clickMode,
    paused: false,
    layoutPass: 0,
    layoutGeneration: 0,
    startedAt: Date.now()
  };

  await setSession(session);
  await updatePaneRoles(session);
  await Promise.all(Object.values(session.panes).map((pane) => requestPaneViewport(pane.tabId)));
  await chrome.windows.update(masterPane.windowId, { focused: true });
  await notifyLauncher(session);
  return session;
}

async function setClickMode(value) {
  const session = await getSession();
  if (!session.active) throw new Error("还没有运行中的多屏会话");
  session.clickMode = normalizeClickMode(value);
  await setSession(session);
  await updatePaneRoles(session);
  await notifyLauncher(session);
  return session;
}

async function focusMaster() {
  const session = await getSession();
  const pane = session.panes?.[String(session.masterTabId)];
  if (!session.active || !pane) throw new Error("还没有运行中的主屏");
  await chrome.windows.update(pane.windowId, { focused: true });
  await chrome.tabs.update(pane.tabId, { active: true });
  return session;
}

async function reloadSession() {
  const session = await getSession();
  const panes = Object.values(session.panes || {});
  if (!session.active || !panes.length) throw new Error("还没有运行中的多屏会话");

  panes.forEach((pane) => {
    pane.calibrated = false;
    pane.calibrationAttempts = 0;
    session.panes[String(pane.tabId)] = pane;
  });
  await setSession(session);
  await notifyLauncher(session);
  await Promise.all(panes.map((pane) => chrome.tabs.reload(pane.tabId).catch(() => {})));
  return session;
}

async function toggleSync() {
  const session = await getSession();
  const panes = Object.values(session.panes || {});
  if (!session.active || !panes.length) throw new Error("还没有运行中的多屏会话");

  if (!session.paused) {
    session.paused = true;
    await setSession(session);
    await updatePaneRoles(session);
    await notifyLauncher(session);
    return session;
  }

  const masterTab = await chrome.tabs.get(session.masterTabId).catch(() => null);
  if (masterTab?.url && /^https?:/.test(masterTab.url)) session.url = masterTab.url;
  await setSession(session);

  await Promise.all(panes.map(async (pane) => {
    const tab = await chrome.tabs.get(pane.tabId).catch(() => null);
    if (pane.tabId !== session.masterTabId && tab?.url !== session.url) {
      await chrome.tabs.update(pane.tabId, { url: session.url }).catch(() => {});
    }
    await waitForTabComplete(pane.tabId);
  }));

  session.paused = false;
  await setSession(session);
  await updatePaneRoles(session);
  await alignFollowersToMasterScroll(session, panes);
  await notifyLauncher(session);
  return session;
}

async function alignFollowersToMasterScroll(session, panes) {
  const position = await chrome.tabs.sendMessage(session.masterTabId, {
    type: "read-scroll-position"
  }).catch(() => null);
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;

  await Promise.all(panes
    .filter((pane) => pane.tabId !== session.masterTabId)
    .map((pane) => chrome.tabs.sendMessage(pane.tabId, {
      type: "apply-scroll",
      x: position.x,
      y: position.y
    }).catch(() => {})));
}

async function waitForTabComplete(tabId, timeout = 6000) {
  await new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, timeout);
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish();
      })
      .catch(finish);
  });
}

async function arrangeSession(anchorWindowId) {
  const session = await getSession();
  const panes = Object.values(session.panes || {}).sort((a, b) => a.index - b.index);
  if (!session.active || !panes.length) {
    throw new Error("还没有可整理的多屏会话");
  }

  const masterPane = panes.find((pane) => pane.tabId === session.masterTabId) || panes[0];
  const referenceWindowId = masterPane.windowId || anchorWindowId;
  const anchorWindow = await chrome.windows.get(referenceWindowId);
  const workArea = await getWorkArea(anchorWindow);
  const layout = createLayout(panes.map((pane) => ({
    id: String(pane.tabId),
    width: pane.targetWidth,
    height: pane.targetHeight,
    frameWidth: pane.frameWidth,
    frameHeight: pane.frameHeight
  })), workArea);
  assertLayoutPossible(layout);

  session.layoutPass = 0;
  await applyLayout(session, panes, layout);

  await chrome.windows.update(masterPane.windowId, { focused: true });
  await notifyLauncher(session);
  return session;
}

async function applyLayout(session, panes, layout) {
  session.layoutGeneration = (session.layoutGeneration || 0) + 1;
  panes.forEach((pane) => {
    pane.displayScale = layout.scale;
    pane.calibrated = false;
    pane.calibrationAttempts = 0;
    session.panes[String(pane.tabId)] = pane;
  });
  await setSession(session);

  await Promise.all(panes.map(async (pane, index) => {
    const bounds = layout.windows.find((windowLayout) => windowLayout.index === index);
    await chrome.tabs.setZoom(pane.tabId, layout.scale);
    await chrome.windows.update(pane.windowId, {
      state: "normal",
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height
    });
  }));

  setTimeout(() => {
    panes.forEach((pane) => chrome.tabs.sendMessage(pane.tabId, {
      type: "report-viewport",
      layoutGeneration: session.layoutGeneration
    }).catch(() => {}));
  }, 220);
}

async function getWorkArea(anchorWindow) {
  try {
    const displays = await chrome.system.display.getInfo();
    return ViewportRelayLayout.chooseWorkArea(displays, anchorWindow);
  } catch {
    return {
      left: Number.isFinite(anchorWindow.left) ? anchorWindow.left : 0,
      top: Number.isFinite(anchorWindow.top) ? anchorWindow.top : 0,
      width: Math.max(anchorWindow.width || 1280, 760),
      height: Math.max(anchorWindow.height || 800, 560)
    };
  }
}

function createLayout(devices, workArea) {
  return ViewportRelayLayout.buildLayoutPlan(
    devices.map((device, index) => ({ ...device, index })),
    workArea,
    {
      gap: WINDOW_GAP,
      margin: WINDOW_MARGIN,
      chromeWidth: WINDOW_CHROME_WIDTH,
      chromeHeight: WINDOW_CHROME_HEIGHT
    }
  );
}

async function closeSession() {
  const session = await getSession();
  const windowIds = [...new Set(Object.values(session.panes || {}).map((pane) => pane.windowId))];
  const closedSession = emptySession();

  await setSession(closedSession);

  await Promise.all(windowIds.map(async (windowId) => {
    try {
      await chrome.windows.remove(windowId);
    } catch {
      // The user may have already closed this window.
    }
  }));

  await notifyLauncher(closedSession);
  return closedSession;
}

async function configurePane(tabId, viewport, layoutGeneration) {
  const session = await getSession();
  const pane = session.panes?.[String(tabId)];
  if (!pane) return false;
  if (Number(layoutGeneration || 0) !== Number(session.layoutGeneration || 0)) {
    await chrome.tabs.sendMessage(tabId, {
      type: "report-viewport",
      layoutGeneration: session.layoutGeneration || 0
    }).catch(() => {});
    return true;
  }

  await sendRole(tabId, session, pane);

  const viewportWidth = Number(viewport?.width || 0);
  const viewportHeight = Number(viewport?.height || 0);
  const currentWindow = await chrome.windows.get(pane.windowId);
  const displayScale = pane.displayScale || 1;
  pane.frameWidth = Math.max(0, currentWindow.width - Math.round(viewportWidth * displayScale));
  pane.frameHeight = Math.max(0, currentWindow.height - Math.round(viewportHeight * displayScale));
  const widthDelta = pane.targetWidth - viewportWidth;
  const heightDelta = pane.targetHeight - viewportHeight;
  const closeEnough = Math.abs(widthDelta) <= 1 && Math.abs(heightDelta) <= 1;

  if (closeEnough || pane.calibrationAttempts >= 3) {
    pane.calibrated = closeEnough;
    session.panes[String(tabId)] = pane;
    await setSession(session);

    const panes = Object.values(session.panes).sort((a, b) => a.index - b.index);
    const allSettled = panes.every((item) => item.calibrated || item.calibrationAttempts >= 3);
    if (allSettled && session.layoutPass < 1) {
      await refineMeasuredLayout(session, panes);
      return true;
    }

    await notifyLauncher(session);
    return true;
  }

  pane.calibrationAttempts += 1;
  session.panes[String(tabId)] = pane;
  await setSession(session);

  await chrome.windows.update(pane.windowId, {
    width: Math.max(240, currentWindow.width + Math.round(widthDelta * displayScale)),
    height: Math.max(180, currentWindow.height + Math.round(heightDelta * displayScale))
  });

  const currentGeneration = session.layoutGeneration || 0;
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, {
      type: "report-viewport",
      layoutGeneration: currentGeneration
    }).catch(() => {});
  }, 180);

  return true;
}

async function requestPaneViewport(tabId) {
  const session = await getSession();
  if (!session.panes?.[String(tabId)]) return false;
  await chrome.tabs.sendMessage(tabId, {
    type: "report-viewport",
    layoutGeneration: session.layoutGeneration || 0
  }).catch(() => {});
  return true;
}

async function refineMeasuredLayout(session, panes) {
  const masterPane = panes.find((pane) => pane.tabId === session.masterTabId) || panes[0];
  const anchorWindow = await chrome.windows.get(masterPane.windowId);
  const workArea = await getWorkArea(anchorWindow);
  const layout = createLayout(panes.map((pane) => ({
    id: String(pane.tabId),
    width: pane.targetWidth,
    height: pane.targetHeight,
    frameWidth: pane.frameWidth,
    frameHeight: pane.frameHeight
  })), workArea);

  if (!layout.possible) {
    session.layoutPass = 1;
    await setSession(session);
    await notifyLauncher(session);
    return;
  }

  session.layoutPass = 1;
  await applyLayout(session, panes, layout);
  await notifyLauncher(session);
}

async function relayMasterEvent(senderTabId, message) {
  const session = await getSession();
  if (!session.active || session.paused || senderTabId !== session.masterTabId) return;

  const candidateTabIds = Object.values(session.panes)
    .map((pane) => pane.tabId)
    .filter((tabId) => tabId !== senderTabId);
  let targetTabIds = candidateTabIds;

  let outgoing;
  if (message.type === "master-scroll") {
    outgoing = { type: "apply-scroll", x: message.x, y: message.y };
  } else {
    const pageTargets = await samePageTabs(senderTabId, candidateTabIds);
    targetTabIds = pageTargets.tabIds;
    if (normalizeClickMode(session.clickMode) === "coordinate") {
      outgoing = {
        type: "apply-click",
        xRatio: message.xRatio,
        yRatio: message.yRatio,
        pageKey: pageTargets.pageKey
      };
    } else {
      const target = sanitizeTargetDescriptor(message.target);
      if (!target) return;
      outgoing = { type: "apply-dom-click", target, pageKey: pageTargets.pageKey };
    }
  }

  await Promise.all(targetTabIds.map((tabId) => chrome.tabs.sendMessage(tabId, outgoing).catch(() => {})));
}

async function syncMasterNavigation(tabId, url) {
  const session = await getSession();
  if (!session.active || session.paused || tabId !== session.masterTabId || session.url === url) return;

  session.url = url;
  await setSession(session);

  const followers = Object.values(session.panes).filter((pane) => pane.tabId !== tabId);
  await Promise.all(followers.map(async (pane) => {
    try {
      const follower = await chrome.tabs.get(pane.tabId);
      if (follower.url !== url) {
        await chrome.tabs.update(pane.tabId, { url });
      }
    } catch {
      // A window may be closing while navigation is being relayed.
    }
  }));

  await notifyLauncher(session);
}

async function removePane(tabId) {
  const session = await getSession();
  if (!session.panes?.[String(tabId)]) return;

  delete session.panes[String(tabId)];
  const remaining = Object.values(session.panes);

  if (!remaining.length) {
    await setSession(emptySession());
    await notifyLauncher(emptySession());
    return;
  }

  if (session.masterTabId === tabId) {
    session.masterTabId = remaining.sort((a, b) => a.index - b.index)[0].tabId;
  }

  await setSession(session);
  await updatePaneRoles(session);
  await notifyLauncher(session);
}

async function updatePaneRoles(session) {
  await Promise.all(Object.values(session.panes).map((pane) => sendRole(pane.tabId, session, pane)));
}

async function sendRole(tabId, session, pane) {
  await chrome.tabs.sendMessage(tabId, {
    type: "set-role",
    role: tabId === session.masterTabId ? "master" : "follower",
    label: pane.label,
    targetWidth: pane.targetWidth,
    targetHeight: pane.targetHeight,
    clickMode: normalizeClickMode(session.clickMode),
    paused: Boolean(session.paused),
    layoutGeneration: session.layoutGeneration || 0
  }).catch(() => {});
}

async function notifyLauncher(session) {
  await chrome.runtime.sendMessage({
    type: "session-updated",
    session: publicSession(session)
  }).catch(() => {});
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error("请输入要测试的网址");

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(candidate);

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("目前只支持 http 和 https 地址");
  }

  return parsed.href;
}

function normalizeDevices(value) {
  const devices = Array.isArray(value) ? value : [];
  if (devices.length > MAX_DEVICE_COUNT) {
    throw new Error(`一次最多打开 ${MAX_DEVICE_COUNT} 个屏幕`);
  }

  return devices.map((device) => {
    const width = Number(device?.width);
    const height = Number(device?.height);
    if (!Number.isFinite(width) || width < 240 || width > 1000
      || !Number.isFinite(height) || height < 320 || height > 2000) {
      throw new Error("屏幕尺寸超出支持范围");
    }

    return {
      id: String(device.id || "screen").slice(0, 80),
      label: String(device.label || "屏幕").slice(0, 80),
      width: Math.round(width),
      height: Math.round(height)
    };
  });
}

function normalizeClickMode(value) {
  return value === "coordinate" ? "coordinate" : "dom";
}

function sanitizeTargetDescriptor(value) {
  if (!value || typeof value !== "object") return null;
  const tag = String(value.tag || "").toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;

  const attributes = {};
  Object.entries(value.attributes || {}).forEach(([key, attributeValue]) => {
    if (!TARGET_ATTRIBUTES.has(key)) return;
    const cleaned = key === "href"
      ? sanitizeHref(attributeValue)
      : String(attributeValue || "").slice(0, 200);
    if (cleaned) attributes[key] = cleaned;
  });
  const id = String(value.id || "").slice(0, 160);
  const selectors = [];
  if (id) selectors.push({ kind: "identity", value: `#${escapeIdentifier(id)}` });
  Object.entries(attributes).forEach(([key, attributeValue]) => {
    selectors.push({
      kind: "attribute",
      value: `${tag}[${key}="${escapeAttribute(attributeValue)}"]`
    });
  });

  return {
    version: 1,
    tag,
    id,
    text: String(value.text || "").slice(0, 160),
    classNames: (Array.isArray(value.classNames) ? value.classNames : [])
      .slice(0, 6)
      .map((className) => String(className).slice(0, 64)),
    attributes,
    selectors
  };
}

async function samePageTabs(sourceTabId, candidateTabIds) {
  const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
  const sourcePageKey = pageKey(sourceTab?.url);
  if (!sourcePageKey) return { tabIds: [], pageKey: "" };

  const matches = await Promise.all(candidateTabIds.map(async (tabId) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return pageKey(tab?.url) === sourcePageKey ? tabId : null;
  }));
  return { tabIds: matches.filter(Number.isInteger), pageKey: sourcePageKey };
}

function pageKey(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol)
      ? `${url.origin}${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}

function escapeIdentifier(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0).toString(16)} `);
}

function escapeAttribute(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/[\n\r\f]/g, " ");
}

function sanitizeHref(value) {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}`.slice(0, 200) : "";
  } catch {
    return "";
  }
}

function isLauncherSender(sender) {
  const launcherUrl = chrome.runtime.getURL(LAUNCHER_PATH);
  return sender.url === launcherUrl || sender.tab?.url === launcherUrl;
}

function publicSession(session) {
  const panes = Object.values(session.panes || {}).sort((a, b) => a.index - b.index);
  return {
    active: Boolean(session.active && panes.length),
    url: session.url || "",
    clickMode: normalizeClickMode(session.clickMode),
    paused: Boolean(session.paused),
    masterTabId: session.masterTabId || null,
    panes: panes.map((pane) => ({
      tabId: pane.tabId,
      label: pane.label,
      targetWidth: pane.targetWidth,
      targetHeight: pane.targetHeight,
      calibrated: pane.calibrated,
      role: pane.tabId === session.masterTabId ? "master" : "follower"
    }))
  };
}

function emptySession() {
  return {
    active: false,
    url: "",
    masterTabId: null,
    panes: {},
    clickMode: "dom",
    paused: false,
    layoutPass: 0,
    layoutGeneration: 0,
    startedAt: null
  };
}

function assertLayoutPossible(layout) {
  if (!layout.possible) {
    throw new Error("当前显示器空间不足，请减少屏幕数量后重试");
  }
}

async function getSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || emptySession();
}

async function setSession(session) {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
}
