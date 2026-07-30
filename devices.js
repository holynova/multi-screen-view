(function exposeViewportRelayDevices(globalScope) {
  const WIDTH_RANGE = { min: 240, max: 1000 };
  const HEIGHT_RANGE = { min: 320, max: 2000 };
  const MAX_CUSTOM_DEVICES = 8;

  function createCustomDevice(input, id) {
    const width = Math.round(Number(input?.width));
    const height = Math.round(Number(input?.height));
    if (!Number.isFinite(width) || width < WIDTH_RANGE.min || width > WIDTH_RANGE.max) {
      throw new Error(`宽度需在 ${WIDTH_RANGE.min} 到 ${WIDTH_RANGE.max} px 之间`);
    }
    if (!Number.isFinite(height) || height < HEIGHT_RANGE.min || height > HEIGHT_RANGE.max) {
      throw new Error(`高度需在 ${HEIGHT_RANGE.min} 到 ${HEIGHT_RANGE.max} px 之间`);
    }

    const safeId = String(id || "").toLowerCase();
    if (!/^custom-[a-z0-9-]{1,64}$/.test(safeId)) {
      throw new Error("自定义尺寸 ID 无效");
    }

    const label = cleanLabel(input?.label) || `${width} × ${height}`;
    return {
      id: safeId,
      label,
      note: "自定义尺寸",
      width,
      height,
      enabled: input?.enabled !== false,
      custom: true
    };
  }

  function sanitizeCustomDevices(value) {
    const devices = Array.isArray(value) ? value : [];
    const seen = new Set();
    const sanitized = [];

    for (const item of devices.slice(0, MAX_CUSTOM_DEVICES)) {
      try {
        const device = createCustomDevice(item, item?.id);
        if (seen.has(device.id)) continue;
        seen.add(device.id);
        sanitized.push(device);
      } catch {
        // Ignore malformed data from an older or manually edited storage entry.
      }
    }
    return sanitized;
  }

  function cleanLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 32);
  }

  function normalizeSelection(devices, selectedIds, masterId, maxActive) {
    const availableIds = new Set((Array.isArray(devices) ? devices : []).map((device) => device.id));
    const candidates = Array.isArray(selectedIds) || selectedIds instanceof Set
      ? [...selectedIds]
      : [];
    const limit = Number.isInteger(maxActive) && maxActive > 0 ? maxActive : candidates.length;
    const normalizedIds = [];

    for (const id of candidates) {
      if (!availableIds.has(id) || normalizedIds.includes(id) || normalizedIds.length >= limit) continue;
      normalizedIds.push(id);
    }

    return {
      selectedIds: normalizedIds,
      masterId: normalizedIds.includes(masterId) ? masterId : (normalizedIds[0] || "")
    };
  }

  const api = {
    HEIGHT_RANGE,
    MAX_CUSTOM_DEVICES,
    WIDTH_RANGE,
    cleanLabel,
    createCustomDevice,
    normalizeSelection,
    sanitizeCustomDevices
  };
  globalScope.ViewportRelayDevices = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
