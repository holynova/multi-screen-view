const DEVICE_PRESETS = [
  { id: "iphone-se", label: "iPhone SE", note: "小屏基线", width: 375, height: 667, enabled: true },
  { id: "iphone-xr", label: "iPhone XR", note: "宽屏旧机型", width: 414, height: 896, enabled: true },
  { id: "iphone-16-pro", label: "iPhone 16 Pro", note: "默认主屏", width: 402, height: 874, enabled: true },
  { id: "iphone-16-pro-max", label: "iPhone 16 Pro Max", note: "大屏基线", width: 440, height: 956, enabled: true }
];
const REPO_URL = "https://github.com/holynova/multi-screen-view";
const IS_EXTENSION = Boolean(globalThis.chrome?.runtime?.id);

const form = document.getElementById("launch-form");
const deviceList = document.getElementById("device-list");
const urlInput = document.getElementById("url");
const formError = document.getElementById("form-error");
const arrangeButton = document.getElementById("arrange-windows");
const closeButton = document.getElementById("close-session");
const statusCopy = document.getElementById("status-copy");
const submitButton = form.querySelector("button[type='submit']");
let arrangeBusy = false;

renderDevices();
if (IS_EXTENSION) {
  refreshSession();
} else {
  renderWebPreview();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  if (!IS_EXTENSION) {
    window.location.href = REPO_URL;
    return;
  }

  const devices = selectedDevices();
  const master = document.querySelector("input[name='master']:checked")?.value;

  if (!urlInput.value.trim()) {
    showError("请输入要测试的网址");
    urlInput.focus();
    return;
  }

  if (!devices.length) {
    showError("请至少选择一个屏幕尺寸");
    return;
  }

  if (!devices.some((device) => device.id === master)) {
    showError("主屏必须是已启用的屏幕");
    return;
  }

  setBusy(true);
  const response = await chrome.runtime.sendMessage({
    type: "launch-session",
    payload: { url: urlInput.value, devices, masterId: master }
  }).catch((error) => ({ ok: false, error: error.message }));
  setBusy(false);

  if (!response?.ok) {
    showError(response?.error || "无法启动多屏窗口");
    return;
  }

  renderSession(response.session);
});

closeButton.addEventListener("click", async () => {
  if (!IS_EXTENSION) return;
  closeButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "close-session" }).catch(() => {});
  renderSession({ active: false, panes: [] });
});

arrangeButton.addEventListener("click", async () => {
  if (!IS_EXTENSION || arrangeBusy) return;
  clearError();
  arrangeBusy = true;
  arrangeButton.disabled = true;
  arrangeButton.textContent = "正在整理";
  const response = await chrome.runtime.sendMessage({ type: "arrange-session" })
    .catch((error) => ({ ok: false, error: error.message }));
  arrangeButton.textContent = "整理窗口";

  if (!response?.ok) {
    showError(response?.error || "无法整理多屏窗口");
    arrangeBusy = false;
    arrangeButton.disabled = false;
    return;
  }

  arrangeBusy = false;
  renderSession(response.session);
});

deviceList.addEventListener("change", (event) => {
  if (!event.target.matches("input[type='checkbox']")) return;

  const row = event.target.closest(".device-row");
  const radio = row.querySelector("input[type='radio']");
  radio.disabled = !event.target.checked;
  row.classList.toggle("is-disabled", !event.target.checked);

  if (!event.target.checked && radio.checked) {
    const next = [...document.querySelectorAll("input[name='master']:not(:disabled)")][0];
    if (next) next.checked = true;
  }
});

if (IS_EXTENSION) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "session-updated") {
      renderSession(message.session);
    }
  });
}

function renderDevices() {
  deviceList.innerHTML = DEVICE_PRESETS.map((device) => `
    <div class="device-row" data-device-id="${device.id}">
      <label class="screen-toggle">
        <input type="checkbox" ${device.enabled ? "checked" : ""} aria-label="启用 ${device.label}">
        <span aria-hidden="true"></span>
      </label>
      <div class="device-identity">
        <strong>${device.label}</strong>
        <span>${device.note}</span>
      </div>
      <div class="dimensions" aria-label="${device.width} 乘 ${device.height}">
        <b>${device.width}</b><span>×</span><b>${device.height}</b>
      </div>
      <label class="master-choice">
        <input type="radio" name="master" value="${device.id}" ${device.id === "iphone-16-pro" ? "checked" : ""}>
        <span>主屏</span>
      </label>
    </div>
  `).join("");
}

function selectedDevices() {
  return DEVICE_PRESETS.filter((device) => {
    const row = deviceList.querySelector(`[data-device-id='${device.id}']`);
    return row.querySelector("input[type='checkbox']").checked;
  });
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
  arrangeButton.disabled = true;
  closeButton.disabled = true;
}

function renderSession(session) {
  const panes = session?.panes || [];
  if (!session?.active || !panes.length) {
    statusCopy.textContent = "还没有启动多屏会话。";
    arrangeButton.disabled = true;
    closeButton.disabled = true;
    return;
  }

  const master = panes.find((pane) => pane.role === "master");
  const calibrated = panes.filter((pane) => pane.calibrated).length;
  statusCopy.textContent = `${panes.length} 个窗口正在运行，主屏为 ${master?.label || "第一个窗口"}，${calibrated}/${panes.length} 个视口已校准。`;
  arrangeButton.disabled = arrangeBusy;
  closeButton.disabled = false;
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
