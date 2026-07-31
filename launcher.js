const DEVICE_PRESETS = [
  { id: "iphone-se", label: "iPhone SE", note: "小屏基线", width: 375, height: 667, enabled: true },
  { id: "iphone-xr", label: "iPhone XR", note: "宽屏旧机型", width: 414, height: 896, enabled: true },
  { id: "iphone-16-pro", label: "iPhone 16 Pro", note: "默认主屏", width: 402, height: 874, enabled: true },
  { id: "iphone-16-pro-max", label: "iPhone 16 Pro Max", note: "大屏基线", width: 440, height: 956, enabled: true }
];
const REPO_URL = "https://github.com/holynova/multi-screen-view";
const CUSTOM_DEVICES_KEY = "viewportRelayCustomDevices";
const PRIVACY_CONSENT_KEY = "viewportRelayPrivacyConsentV1";
const MAX_ACTIVE_DEVICES = 8;
const IS_EXTENSION = Boolean(globalThis.chrome?.runtime?.id);

const form = document.getElementById("launch-form");
const deviceList = document.getElementById("device-list");
const urlInput = document.getElementById("url");
const formError = document.getElementById("form-error");
const clickModeField = document.getElementById("click-mode");
const dataConsentInput = document.getElementById("data-consent");
const customDeviceName = document.getElementById("custom-device-name");
const customDeviceWidth = document.getElementById("custom-device-width");
const customDeviceHeight = document.getElementById("custom-device-height");
const customDeviceError = document.getElementById("custom-device-error");
const addCustomDeviceButton = document.getElementById("add-custom-device");
const focusMasterButton = document.getElementById("focus-master");
const reloadSessionButton = document.getElementById("reload-session");
const toggleSyncButton = document.getElementById("toggle-sync");
const arrangeButton = document.getElementById("arrange-windows");
const closeButton = document.getElementById("close-session");
const statusCopy = document.getElementById("status-copy");
const submitButton = form.querySelector("button[type='submit']");
const sessionControlButtons = [
  focusMasterButton,
  reloadSessionButton,
  toggleSyncButton,
  arrangeButton,
  closeButton
];
let devices = DEVICE_PRESETS.map((device) => ({ ...device }));
let selectedDeviceIds = new Set(DEVICE_PRESETS.filter((device) => device.enabled).map((device) => device.id));
let masterDeviceId = "iphone-16-pro";
let activeSession = false;
let syncPaused = false;

initialize();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  if (!IS_EXTENSION) {
    window.location.href = REPO_URL;
    return;
  }

  if (!dataConsentInput.checked) {
    showError("请先确认页面数据处理说明");
    dataConsentInput.focus();
    return;
  }

  const devices = selectedDevices();
  const master = masterDeviceId;
  const clickMode = selectedClickMode();

  if (!urlInput.value.trim()) {
    showError("请输入要测试的网址");
    urlInput.focus();
    return;
  }

  if (!devices.length) {
    showError("请至少选择一个屏幕尺寸");
    return;
  }

  if (devices.length > MAX_ACTIVE_DEVICES) {
    showError(`一次最多启用 ${MAX_ACTIVE_DEVICES} 个屏幕尺寸`);
    return;
  }

  if (!devices.some((device) => device.id === master)) {
    showError("主屏必须是已启用的屏幕");
    return;
  }

  setBusy(true);
  await savePrivacyConsent(true);
  const response = await chrome.runtime.sendMessage({
    type: "launch-session",
    payload: { url: urlInput.value, devices, masterId: master, clickMode }
  }).catch((error) => ({ ok: false, error: error.message }));
  setBusy(false);

  if (!response?.ok) {
    showError(response?.error || "无法启动多屏窗口");
    return;
  }

  renderSession(response.session);
});

clickModeField.addEventListener("change", async (event) => {
  if (!IS_EXTENSION || !activeSession || !event.target.matches("input[name='click-mode']")) return;
  clearError();
  const response = await chrome.runtime.sendMessage({
    type: "set-click-mode",
    clickMode: selectedClickMode()
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!response?.ok) {
    showError(response?.error || "无法切换点击同步模式");
    await refreshSession();
    return;
  }
  renderSession(response.session);
});

closeButton.addEventListener("click", () => runSessionControl({
  type: "close-session",
  button: closeButton,
  busyLabel: "正在关闭",
  error: "无法关闭多屏窗口"
}));

focusMasterButton.addEventListener("click", () => runSessionControl({
  type: "focus-master",
  button: focusMasterButton,
  busyLabel: "正在聚焦",
  error: "无法聚焦主屏"
}));

reloadSessionButton.addEventListener("click", () => runSessionControl({
  type: "reload-session",
  button: reloadSessionButton,
  busyLabel: "正在刷新",
  error: "无法刷新多屏页面"
}));

toggleSyncButton.addEventListener("click", () => runSessionControl({
  type: "toggle-sync",
  button: toggleSyncButton,
  busyLabel: syncPaused ? "正在继续" : "正在暂停",
  error: "无法切换同步状态"
}));

arrangeButton.addEventListener("click", () => runSessionControl({
  type: "arrange-session",
  button: arrangeButton,
  busyLabel: "正在整理",
  error: "无法整理多屏窗口"
}));

deviceList.addEventListener("change", async (event) => {
  const row = event.target.closest(".device-row");
  if (!row) return;

  if (event.target.matches("input[type='radio']")) {
    masterDeviceId = event.target.value;
    return;
  }

  if (!event.target.matches("input[type='checkbox']")) return;

  const deviceId = row.dataset.deviceId;
  if (event.target.checked) {
    if (selectedDeviceIds.size >= MAX_ACTIVE_DEVICES) {
      showError(`一次最多启用 ${MAX_ACTIVE_DEVICES} 个屏幕尺寸`);
      renderDevices();
      return;
    }
    selectedDeviceIds.add(deviceId);
  } else {
    selectedDeviceIds.delete(deviceId);
  }
  normalizeDeviceSelection();
  renderDevices();
  await saveCustomDevices().catch(() => {});
});

deviceList.addEventListener("click", async (event) => {
  const button = event.target.closest(".remove-device");
  if (!button) return;
  const deviceId = button.closest(".device-row")?.dataset.deviceId;
  const device = devices.find((item) => item.id === deviceId);
  if (!device?.custom) return;

  devices = devices.filter((item) => item.id !== deviceId);
  selectedDeviceIds.delete(deviceId);
  if (masterDeviceId === deviceId) {
    masterDeviceId = devices.find((item) => selectedDeviceIds.has(item.id))?.id || "iphone-16-pro";
  }
  await saveCustomDevices();
  renderDevices();
});

addCustomDeviceButton.addEventListener("click", addCustomDevice);
[customDeviceName, customDeviceWidth, customDeviceHeight].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addCustomDevice();
  });
});

if (IS_EXTENSION) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "session-updated") {
      renderSession(message.session);
    }
  });
}

async function initialize() {
  const [customDevices, privacyConsent] = await Promise.all([
    loadCustomDevices(),
    loadPrivacyConsent()
  ]);
  dataConsentInput.checked = privacyConsent;
  devices = [...DEVICE_PRESETS.map((device) => ({ ...device })), ...customDevices];
  selectedDeviceIds = new Set(DEVICE_PRESETS
    .filter((device) => device.enabled)
    .map((device) => device.id));
  customDevices
    .filter((device) => device.enabled)
    .forEach((device) => {
      if (selectedDeviceIds.size < MAX_ACTIVE_DEVICES) selectedDeviceIds.add(device.id);
    });
  normalizeDeviceSelection();
  renderDevices();
  if (IS_EXTENSION) await refreshSession();
  else renderWebPreview();
}

dataConsentInput.addEventListener("change", async () => {
  await savePrivacyConsent(dataConsentInput.checked).catch(() => {});
  if (dataConsentInput.checked || !IS_EXTENSION || !activeSession) return;

  const response = await chrome.runtime.sendMessage({ type: "close-session" })
    .catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    showError(response?.error || "无法在撤回同意后关闭多屏窗口");
    return;
  }
  renderSession(response.session);
  statusCopy.textContent = "同意已撤回，运行中的多屏窗口已关闭。";
});

function renderDevices() {
  normalizeDeviceSelection();

  deviceList.innerHTML = devices.map((device) => `
    <div class="device-row" data-device-id="${device.id}">
      <label class="screen-toggle">
        <input type="checkbox" ${selectedDeviceIds.has(device.id) ? "checked" : ""} aria-label="启用 ${escapeHtml(device.label)}">
        <span aria-hidden="true"></span>
      </label>
      <div class="device-identity">
        <strong>${escapeHtml(device.label)}</strong>
        <span>${escapeHtml(device.note)}</span>
      </div>
      <div class="dimensions" aria-label="${device.width} 乘 ${device.height}">
        <b>${device.width}</b><span>×</span><b>${device.height}</b>
      </div>
      <label class="master-choice">
        <input type="radio" name="master" value="${device.id}" ${device.id === masterDeviceId ? "checked" : ""} ${selectedDeviceIds.has(device.id) ? "" : "disabled"}>
        <span>主屏</span>
      </label>
      ${device.custom
        ? `<button class="remove-device" type="button" aria-label="删除 ${escapeHtml(device.label)}">删除</button>`
        : '<span class="device-row-spacer" aria-hidden="true"></span>'}
    </div>
  `).join("");

  deviceList.querySelectorAll(".device-row").forEach((row) => {
    row.classList.toggle("is-disabled", !selectedDeviceIds.has(row.dataset.deviceId));
  });
}

function selectedDevices() {
  return devices.filter((device) => selectedDeviceIds.has(device.id));
}

function selectedClickMode() {
  return document.querySelector("input[name='click-mode']:checked")?.value === "coordinate"
    ? "coordinate"
    : "dom";
}

async function refreshSession() {
  const response = await chrome.runtime.sendMessage({ type: "get-session" }).catch(() => null);
  if (response?.ok) renderSession(response.session);
}

function renderWebPreview() {
  document.body.classList.add("is-web-preview");
  urlInput.readOnly = true;
  submitButton.lastChild.textContent = " 获取扩展";
  statusCopy.textContent = "当前为网页预览。安装 Chrome 扩展后即可启动多屏同步。";
  setSessionControlsDisabled(true);
}

function renderSession(session) {
  const panes = session?.panes || [];
  if (!session?.active || !panes.length) {
    activeSession = false;
    syncPaused = false;
    statusCopy.textContent = "还没有启动多屏会话。";
    toggleSyncButton.textContent = "暂停同步";
    toggleSyncButton.classList.remove("is-active");
    setSessionControlsDisabled(true);
    return;
  }

  activeSession = true;
  syncPaused = Boolean(session.paused);
  const clickMode = session.clickMode === "coordinate" ? "coordinate" : "dom";
  const modeInput = document.querySelector(`input[name='click-mode'][value='${clickMode}']`);
  if (modeInput) modeInput.checked = true;
  const master = panes.find((pane) => pane.role === "master");
  const calibrated = panes.filter((pane) => pane.calibrated).length;
  const modeLabel = clickMode === "dom" ? "DOM 元素匹配" : "相对坐标";
  statusCopy.textContent = syncPaused
    ? `同步已暂停，${panes.length} 个窗口保持打开。主屏为 ${master?.label || "第一个窗口"}。`
    : `${panes.length} 个窗口正在运行，主屏为 ${master?.label || "第一个窗口"}，点击模式为 ${modeLabel}，${calibrated}/${panes.length} 个视口已校准。`;
  toggleSyncButton.textContent = syncPaused ? "继续同步" : "暂停同步";
  toggleSyncButton.classList.toggle("is-active", syncPaused);
  setSessionControlsDisabled(false);
}

async function addCustomDevice() {
  customDeviceError.textContent = "";
  const customCount = devices.filter((device) => device.custom).length;
  if (customCount >= ViewportRelayDevices.MAX_CUSTOM_DEVICES) {
    customDeviceError.textContent = `最多保存 ${ViewportRelayDevices.MAX_CUSTOM_DEVICES} 个自定义尺寸`;
    return;
  }

  try {
    const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const device = ViewportRelayDevices.createCustomDevice({
      label: customDeviceName.value,
      width: customDeviceWidth.value,
      height: customDeviceHeight.value
    }, id);
    devices.push(device);
    if (selectedDeviceIds.size < MAX_ACTIVE_DEVICES) {
      selectedDeviceIds.add(device.id);
    }
    await saveCustomDevices();
    renderDevices();
    customDeviceName.value = "";
    customDeviceWidth.value = "";
    customDeviceHeight.value = "";
    customDeviceName.focus();
  } catch (error) {
    customDeviceError.textContent = error.message;
  }
}

async function loadCustomDevices() {
  try {
    const value = IS_EXTENSION
      ? (await chrome.storage.local.get(CUSTOM_DEVICES_KEY))[CUSTOM_DEVICES_KEY]
      : JSON.parse(localStorage.getItem(CUSTOM_DEVICES_KEY) || "[]");
    return ViewportRelayDevices.sanitizeCustomDevices(value);
  } catch {
    return [];
  }
}

async function saveCustomDevices() {
  const customDevices = devices
    .filter((device) => device.custom)
    .map((device) => ({
      ...device,
      enabled: selectedDeviceIds.has(device.id)
    }));
  if (IS_EXTENSION) {
    await chrome.storage.local.set({ [CUSTOM_DEVICES_KEY]: customDevices });
  } else {
    localStorage.setItem(CUSTOM_DEVICES_KEY, JSON.stringify(customDevices));
  }
}

async function loadPrivacyConsent() {
  try {
    if (IS_EXTENSION) {
      return (await chrome.storage.local.get(PRIVACY_CONSENT_KEY))[PRIVACY_CONSENT_KEY] === true;
    }
    return localStorage.getItem(PRIVACY_CONSENT_KEY) === "true";
  } catch {
    return false;
  }
}

async function savePrivacyConsent(value) {
  if (IS_EXTENSION) {
    await chrome.storage.local.set({ [PRIVACY_CONSENT_KEY]: Boolean(value) });
    return;
  }
  localStorage.setItem(PRIVACY_CONSENT_KEY, String(Boolean(value)));
}

async function runSessionControl({ type, button, busyLabel, error }) {
  if (!IS_EXTENSION || !activeSession || button.disabled) return;
  clearError();
  const originalLabel = button.textContent;
  setSessionControlsDisabled(true);
  button.textContent = busyLabel;
  const response = await chrome.runtime.sendMessage({ type })
    .catch((requestError) => ({ ok: false, error: requestError.message }));
  button.textContent = originalLabel;

  if (!response?.ok) {
    showError(response?.error || error);
    setSessionControlsDisabled(!activeSession);
    return;
  }
  renderSession(response.session);
}

function normalizeDeviceSelection() {
  const normalized = ViewportRelayDevices.normalizeSelection(
    devices,
    selectedDeviceIds,
    masterDeviceId,
    MAX_ACTIVE_DEVICES
  );
  selectedDeviceIds = new Set(normalized.selectedIds);
  masterDeviceId = normalized.masterId;
}

function setSessionControlsDisabled(disabled) {
  sessionControlButtons.forEach((button) => {
    button.disabled = disabled;
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showError(message) {
  formError.textContent = message;
}

function clearError() {
  formError.textContent = "";
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.lastChild.textContent = busy ? " 正在打开" : " 启动多屏";
}
