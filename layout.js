(function exposeViewportRelayLayout(globalScope) {
  const DEFAULTS = {
    gap: 14,
    margin: 16,
    chromeWidth: 16,
    chromeHeight: 46,
    minWindowWidth: 240,
    minWindowHeight: 180
  };
  const MIN_ZOOM = 0.25;

  function buildLayoutPlan(devices, workArea, options = {}) {
    if (!Array.isArray(devices) || !devices.length) {
      return { possible: true, scale: 1, columns: 0, rows: 0, windows: [] };
    }

    const config = { ...DEFAULTS, ...options };
    const area = normalizeRect(workArea);
    const innerArea = {
      left: area.left + config.margin,
      top: area.top + config.margin,
      width: Math.max(1, area.width - config.margin * 2),
      height: Math.max(1, area.height - config.margin * 2)
    };
    let best = null;

    for (let columns = 1; columns <= devices.length; columns += 1) {
      const rows = chunk(devices, columns);
      if (!fits(rows, MIN_ZOOM, innerArea, config)) continue;

      let low = MIN_ZOOM;
      let high = 1;
      if (fits(rows, 1, innerArea, config)) {
        low = 1;
      } else {
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const midpoint = (low + high) / 2;
          if (fits(rows, midpoint, innerArea, config)) low = midpoint;
          else high = midpoint;
        }
      }

      const candidate = createCandidate(rows, low, innerArea, config, columns);
      if (!best || candidate.scale > best.scale + 0.0001 || (
        Math.abs(candidate.scale - best.scale) <= 0.0001 && candidate.rows < best.rows
      )) {
        best = candidate;
      }
    }

    return best || {
      possible: false,
      scale: MIN_ZOOM,
      columns: 0,
      rows: 0,
      workArea: { ...innerArea },
      windows: []
    };
  }

  function chooseWorkArea(displays, anchorWindow) {
    const available = (Array.isArray(displays) ? displays : [])
      .filter((display) => display?.isEnabled !== false && display?.activeState !== "inactive")
      .map((display) => ({ display, area: normalizeRect(display.workArea || display.bounds) }))
      .filter(({ area }) => area.width > 0 && area.height > 0);

    if (!available.length) return normalizeRect(anchorWindow);

    const anchor = normalizeRect(anchorWindow);
    const center = {
      x: anchor.left + anchor.width / 2,
      y: anchor.top + anchor.height / 2
    };
    const containing = available.find(({ area }) => pointInRect(center, area));
    if (containing) return containing.area;

    return available
      .map(({ area }) => ({ area, distance: distanceToRect(center, area) }))
      .sort((a, b) => a.distance - b.distance)[0].area;
  }

  function createCandidate(rows, scale, area, config, columns) {
    const metrics = rows.map((row) => rowMetrics(row, scale, config));
    const gridHeight = metrics.reduce((sum, row) => sum + row.height, 0)
      + config.gap * Math.max(0, metrics.length - 1);
    let top = area.top + Math.max(0, Math.floor((area.height - gridHeight) / 2));
    const windows = [];

    metrics.forEach((row, rowIndex) => {
      let left = area.left + Math.max(0, Math.floor((area.width - row.width) / 2));
      row.items.forEach((item) => {
        windows.push({
          id: item.device.id,
          index: item.device.index,
          left,
          top,
          width: item.width,
          height: item.height
        });
        left += item.width + config.gap;
      });
      top += row.height + (rowIndex < metrics.length - 1 ? config.gap : 0);
    });

    return {
      possible: true,
      scale: Math.floor(scale * 10000) / 10000,
      columns,
      rows: rows.length,
      workArea: { ...area },
      windows
    };
  }

  function fits(rows, scale, area, config) {
    const metrics = rows.map((row) => rowMetrics(row, scale, config));
    const totalHeight = metrics.reduce((sum, row) => sum + row.height, 0)
      + config.gap * Math.max(0, metrics.length - 1);
    return metrics.every((row) => row.width <= area.width) && totalHeight <= area.height;
  }

  function rowMetrics(row, scale, config) {
    const items = row.map((device) => ({
      device,
      width: Math.max(
        config.minWindowWidth,
        Math.round(device.width * scale) + frameSize(device.frameWidth, config.chromeWidth)
      ),
      height: Math.max(
        config.minWindowHeight,
        Math.round(device.height * scale) + frameSize(device.frameHeight, config.chromeHeight)
      )
    }));
    return {
      items,
      width: items.reduce((sum, item) => sum + item.width, 0) + config.gap * Math.max(0, items.length - 1),
      height: Math.max(...items.map((item) => item.height))
    };
  }

  function normalizeRect(rect = {}) {
    return {
      left: finite(rect.left, 0),
      top: finite(rect.top, 0),
      width: Math.max(1, finite(rect.width, 1280)),
      height: Math.max(1, finite(rect.height, 800))
    };
  }

  function pointInRect(point, rect) {
    return point.x >= rect.left && point.x < rect.left + rect.width
      && point.y >= rect.top && point.y < rect.top + rect.height;
  }

  function distanceToRect(point, rect) {
    const dx = Math.max(rect.left - point.x, 0, point.x - (rect.left + rect.width));
    const dy = Math.max(rect.top - point.y, 0, point.y - (rect.top + rect.height));
    return dx * dx + dy * dy;
  }

  function chunk(items, size) {
    const rows = [];
    for (let index = 0; index < items.length; index += size) {
      rows.push(items.slice(index, index + size));
    }
    return rows;
  }

  function finite(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function frameSize(value, fallback) {
    return Math.max(0, Math.round(finite(value, fallback)));
  }

  const api = { buildLayoutPlan, chooseWorkArea };
  globalScope.ViewportRelayLayout = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
