const SESSION_KEY = "viewportRelaySession";
const LAUNCHER_PATH = "index.html";
const WINDOW_GAP = 14;
const WINDOW_CHROME_WIDTH = 16;
const WINDOW_CHROME_HEIGHT = 46;
let calibrationQueue = Promise.resolve();

chrome.action.onClicked.addListener(openLauncher);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "launch-session") {
    launchSession(message.payload, sender.tab?.windowId)
      .then((session) => sendResponse({ ok: true, session: publicSession(session) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "close-session") {
    closeSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "get-session") {
    getSession().then((session) => sendResponse({ ok: true, session: publicSession(session) }));
    return true;
  }

  if (message.type === "pane-ready" && sender.tab?.id) {
    calibrationQueue = calibrationQueue
      .then(() => configurePane(sender.tab.id, message.viewport))
      .then((registered) => sendResponse({ registered }))
      .catch(() => sendResponse({ registered: false }));
    return true;
  }

  if ((message.type === "master-scroll" || message.type === "master-click") && sender.tab?.id) {
    relayMasterEvent(sender.tab.id, message).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  syncMasterNavigation(tabId, changeInfo.url).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removePane(tabId).catch(() => {});
});

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

async function launchSession(payload, anchorWindowId) {
  const url = normalizeUrl(payload.url);
  const devices = Array.isArray(payload.devices) ? payload.devices : [];

  if (!devices.length) {
    throw new Error("请至少选择一个屏幕尺寸");
  }

  await closeSession();

  const anchorWindow = Number.isInteger(anchorWindowId)
    ? await chrome.windows.get(anchorWindowId)
    : await chrome.windows.getCurrent();
  const startLeft = Math.max(0, Number.isFinite(anchorWindow.left) ? anchorWindow.left : 0);
  const startTop = Math.max(0, Number.isFinite(anchorWindow.top) ? anchorWindow.top : 0);
  const availableWidth = Math.max(anchorWindow.width || 1280, 760);
  const availableContentHeight = Math.max(560, (anchorWindow.height || 900) - WINDOW_CHROME_HEIGHT - 12);
  const panes = {};
  const createdWindowIds = [];
  const tallestDevice = Math.max(...devices.map((device) => device.height));
  const commonDisplayScale = Math.min(1, availableContentHeight / tallestDevice);
  const layouts = devices.map((device) => {
    const displayScale = commonDisplayScale;
    return {
      device,
      displayScale,
      outerWidth: Math.round(device.width * displayScale) + WINDOW_CHROME_WIDTH,
      outerHeight: Math.round(device.height * displayScale) + WINDOW_CHROME_HEIGHT
    };
  });
  const totalWidth = layouts.reduce((sum, layout) => sum + layout.outerWidth, 0)
    + WINDOW_GAP * Math.max(0, layouts.length - 1);
  let sequentialLeft = startLeft;

  try {
    for (const [index, layout] of layouts.entries()) {
      const { device, displayScale, outerWidth, outerHeight } = layout;
      const left = totalWidth <= availableWidth
        ? sequentialLeft
        : startLeft + Math.round(index * Math.max(0, availableWidth - outerWidth) / Math.max(1, layouts.length - 1));

      const created = await chrome.windows.create({
        url,
        type: "popup",
        focused: false,
        left,
        top: startTop,
        width: outerWidth,
        height: outerHeight
      });

      const tabId = created.tabs?.[0]?.id;
      if (!tabId) {
        throw new Error(`无法创建 ${device.label} 窗口`);
      }

      await chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
      await chrome.tabs.setZoom(tabId, displayScale);

      createdWindowIds.push(created.id);
      panes[String(tabId)] = {
        tabId,
        windowId: created.id,
        label: device.label,
        targetWidth: device.width,
        targetHeight: device.height,
        displayScale,
        calibrated: false,
        calibrationAttempts: 0,
        index
      };

      sequentialLeft += outerWidth + WINDOW_GAP;
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
    startedAt: Date.now()
  };

  await setSession(session);
  await updatePaneRoles(session);
  await chrome.windows.update(masterPane.windowId, { focused: true });
  await notifyLauncher(session);
  return session;
}

async function closeSession() {
  const session = await getSession();
  const windowIds = [...new Set(Object.values(session.panes || {}).map((pane) => pane.windowId))];

  await setSession(emptySession());

  await Promise.all(windowIds.map(async (windowId) => {
    try {
      await chrome.windows.remove(windowId);
    } catch {
      // The user may have already closed this window.
    }
  }));

  await notifyLauncher(emptySession());
}

async function configurePane(tabId, viewport) {
  const session = await getSession();
  const pane = session.panes?.[String(tabId)];
  if (!pane) return false;

  await sendRole(tabId, session, pane);

  const widthDelta = pane.targetWidth - Number(viewport?.width || 0);
  const heightDelta = pane.targetHeight - Number(viewport?.height || 0);
  const closeEnough = Math.abs(widthDelta) <= 1 && Math.abs(heightDelta) <= 1;

  if (closeEnough || pane.calibrationAttempts >= 3) {
    pane.calibrated = closeEnough;
    session.panes[String(tabId)] = pane;
    await setSession(session);
    await notifyLauncher(session);
    return true;
  }

  const currentWindow = await chrome.windows.get(pane.windowId);
  const displayScale = pane.displayScale || 1;
  pane.calibrationAttempts += 1;
  session.panes[String(tabId)] = pane;
  await setSession(session);

  await chrome.windows.update(pane.windowId, {
    width: Math.max(240, currentWindow.width + Math.round(widthDelta * displayScale)),
    height: Math.max(180, currentWindow.height + Math.round(heightDelta * displayScale))
  });

  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: "report-viewport" }).catch(() => {});
  }, 180);

  return true;
}

async function relayMasterEvent(senderTabId, message) {
  const session = await getSession();
  if (!session.active || senderTabId !== session.masterTabId) return;

  const targetTabIds = Object.values(session.panes)
    .map((pane) => pane.tabId)
    .filter((tabId) => tabId !== senderTabId);

  const outgoing = message.type === "master-scroll"
    ? { type: "apply-scroll", x: message.x, y: message.y }
    : { type: "apply-click", xRatio: message.xRatio, yRatio: message.yRatio };

  await Promise.all(targetTabIds.map((tabId) => chrome.tabs.sendMessage(tabId, outgoing).catch(() => {})));
}

async function syncMasterNavigation(tabId, url) {
  const session = await getSession();
  if (!session.active || tabId !== session.masterTabId || session.url === url) return;

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
    targetHeight: pane.targetHeight
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
    throw new Error("原型目前只支持 http 和 https 地址");
  }

  return parsed.href;
}

function publicSession(session) {
  const panes = Object.values(session.panes || {}).sort((a, b) => a.index - b.index);
  return {
    active: Boolean(session.active && panes.length),
    url: session.url || "",
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
  return { active: false, url: "", masterTabId: null, panes: {}, startedAt: null };
}

async function getSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || emptySession();
}

async function setSession(session) {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
}
