import fs from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const YEARLY_WEEKS = 53;
const MONTHLY_WEEKS = 6;
const TORTOISE_ASSET_FILENAME = "tortoise.svg";

const VARIANTS = {
  classic: {
    bg: "#0d1117",
    panel: "#010409",
    border: "#30363d",
    title: "#e6edf3",
    subtitle: "#8b949e",
    month: "#8b949e",
    legend: "#8b949e",
    dayLabel: "#8b949e",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
  },
  neon: {
    bg: "#050b14",
    panel: "#081224",
    border: "#1e3952",
    title: "#e9fdff",
    subtitle: "#8ed8e2",
    month: "#8ed8e2",
    legend: "#8ed8e2",
    dayLabel: "#8ed8e2",
    levels: ["#101827", "#0b3c52", "#0b6f86", "#00b7d5", "#6ef6ff"],
  },
  sunset: {
    bg: "#140c14",
    panel: "#1b1120",
    border: "#473043",
    title: "#ffe9de",
    subtitle: "#d7a89d",
    month: "#d7a89d",
    legend: "#d7a89d",
    dayLabel: "#d7a89d",
    levels: ["#241326", "#4a1f3a", "#7b2e4d", "#c1535a", "#ff8b5b"],
  },
  tortoise: {
    bg: "#ffffff",
    panel: "#f6f7f9",
    border: "#d8dde3",
    title: "#101418",
    subtitle: "#4f5b66",
    month: "#4f5b66",
    legend: "#4f5b66",
    dayLabel: "#4f5b66",
    levels: ["#eef2f5", "#dde4ea", "#c8d1da", "#adb9c5", "#8e9ba9"],
  },
};

const GRAPHQL_QUERY = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeVariant(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VARIANTS, normalized)) {
    return normalized;
  }
  return "classic";
}

function normalizeRange(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "monthly" ? "monthly" : "yearly";
}

function normalizeStickerAssignments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  ["top-left", "top-right", "bottom-left", "bottom-right"].forEach((slotId) => {
    const stickerId = String(value?.[slotId] || "").trim();
    if (!stickerId) return;
    normalized[slotId] = stickerId;
  });

  return normalized;
}

function normalizeStickerLayers(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry, index) => {
      const stickerId = String(entry?.stickerId || "").trim();
      if (!stickerId) return null;

      const x = Number(entry?.x);
      const y = Number(entry?.y);
      const sizePx = Number(entry?.sizePx);
      const rotation = Number(entry?.rotation || 0);

      return {
        id: String(entry?.id || "").trim() || `layer-${index}-${stickerId}`,
        stickerId,
        x: Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5,
        y: Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.5,
        sizePx: Number.isFinite(sizePx) ? Math.max(24, Math.min(280, Math.floor(sizePx))) : 112,
        rotation: Number.isFinite(rotation) ? Math.max(-360, Math.min(360, rotation)) : 0,
      };
    })
    .filter(Boolean);
}

function appendStickerOverlay(svgMarkup, overlayMarkup) {
  const svg = String(svgMarkup || "");
  const overlay = String(overlayMarkup || "").trim();
  if (!svg || !overlay) return svg;
  if (!svg.includes("</svg>")) return svg + overlay;
  return svg.replace("</svg>", `${overlay}\n</svg>`);
}

function buildSlotStickerOverlay({
  stickers = {},
  range = "yearly",
  width = 500,
  height = 180,
  hrefMap = {},
} = {}) {
  const normalizedStickers = normalizeStickerAssignments(stickers);
  const entries = Object.entries(normalizedStickers).filter(([slotId]) =>
    range === "monthly" ? slotId === "bottom-left" || slotId === "bottom-right" : true
  );
  if (!entries.length) return "";

  const safeWidth = Math.max(64, Number(width) || 500);
  const safeHeight = Math.max(64, Number(height) || 180);
  const stickerSize =
    range === "monthly"
      ? Math.max(96, Math.min(170, safeHeight - 24))
      : Math.max(56, Math.min(160, Math.floor(safeHeight * 0.32)));
  const margin = range === "monthly" ? 8 : 10;

  const positions = {
    "top-left": { x: margin, y: margin },
    "top-right": { x: safeWidth - margin - stickerSize, y: margin },
    "bottom-left": { x: margin, y: safeHeight - margin - stickerSize },
    "bottom-right": {
      x: safeWidth - margin - stickerSize,
      y: safeHeight - margin - stickerSize,
    },
  };

  const images = entries
    .map(([slotId, stickerId]) => {
      const href = String(hrefMap?.[stickerId] || "").trim();
      if (!href) return "";
      const coords = positions[slotId];
      if (!coords) return "";
      return `<image href="${escapeXml(href)}" x="${coords.x}" y="${coords.y}" width="${stickerSize}" height="${stickerSize}" preserveAspectRatio="xMidYMid meet" />`;
    })
    .filter(Boolean)
    .join("");

  if (!images) return "";
  return `<g aria-label="stickers">${images}</g>`;
}

function buildLayerStickerOverlay({
  stickerLayers = [],
  width = 500,
  height = 180,
  hrefMap = {},
} = {}) {
  const layers = normalizeStickerLayers(stickerLayers);
  if (!layers.length) return "";

  const safeWidth = Math.max(64, Number(width) || 500);
  const safeHeight = Math.max(64, Number(height) || 180);

  const images = layers
    .map((layer) => {
      const href = String(hrefMap?.[layer.stickerId] || "").trim();
      if (!href) return "";

      const centerX = layer.x * safeWidth;
      const centerY = layer.y * safeHeight;
      const x = centerX - layer.sizePx / 2;
      const y = centerY - layer.sizePx / 2;
      const rotate = Number(layer.rotation || 0);
      const transform = rotate
        ? ` transform="rotate(${rotate} ${centerX} ${centerY})"`
        : "";

      return `<image href="${escapeXml(href)}" x="${x}" y="${y}" width="${layer.sizePx}" height="${layer.sizePx}" preserveAspectRatio="xMidYMid meet"${transform} />`;
    })
    .filter(Boolean)
    .join("");

  if (!images) return "";
  return `<g aria-label="sticker-layers">${images}</g>`;
}

function buildTortoiseDecorationImage({
  x = 0,
  y = 0,
  width = 64,
  height = 64,
  href = "",
} = {}) {
  const safeHref = String(href || "").trim();
  if (safeHref) {
    return `<image href="${escapeXml(safeHref)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" />`;
  }

  return `
<g transform="translate(${x} ${y})">
  <ellipse cx="${(width * 0.5).toFixed(2)}" cy="${(height * 0.62).toFixed(2)}" rx="${(width * 0.26).toFixed(2)}" ry="${(height * 0.2).toFixed(2)}" fill="#85c46a" stroke="#4d7f3b" stroke-width="1.6" />
  <ellipse cx="${(width * 0.5).toFixed(2)}" cy="${(height * 0.62).toFixed(2)}" rx="${(width * 0.13).toFixed(2)}" ry="${(height * 0.1).toFixed(2)}" fill="#6ca84f" opacity="0.7" />
  <circle cx="${(width * 0.76).toFixed(2)}" cy="${(height * 0.58).toFixed(2)}" r="${(width * 0.07).toFixed(2)}" fill="#9ccf86" stroke="#5f8c49" stroke-width="1.2" />
  <circle cx="${(width * 0.79).toFixed(2)}" cy="${(height * 0.56).toFixed(2)}" r="${(width * 0.01).toFixed(2)}" fill="#263238" />
  <ellipse cx="${(width * 0.63).toFixed(2)}" cy="${(height * 0.74).toFixed(2)}" rx="${(width * 0.05).toFixed(2)}" ry="${(height * 0.04).toFixed(2)}" fill="#9ccf86" />
  <ellipse cx="${(width * 0.37).toFixed(2)}" cy="${(height * 0.74).toFixed(2)}" rx="${(width * 0.05).toFixed(2)}" ry="${(height * 0.04).toFixed(2)}" fill="#9ccf86" />
</g>`.trim();
}

async function loadTortoiseDataUri(outputPath) {
  const outputDir = path.dirname(path.resolve(process.cwd(), outputPath));
  const tortoisePath = path.join(outputDir, TORTOISE_ASSET_FILENAME);

  try {
    const rawSvg = await fs.readFile(tortoisePath, "utf8");
    return `data:image/svg+xml;utf8,${encodeURIComponent(rawSvg)}`;
  } catch {
    return "";
  }
}

function toIsoDate(value) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "";
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function startOfWeek(date) {
  const copy = new Date(date.getTime());
  const day = copy.getUTCDay();
  copy.setUTCDate(copy.getUTCDate() - day);
  return copy;
}

function quantile(sortedValues, percentile) {
  if (!sortedValues.length) return 0;
  const index = Math.floor((sortedValues.length - 1) * percentile);
  return Number(sortedValues[index] || 0);
}

function buildLevelResolver(counts = []) {
  const nonZero = counts
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (!nonZero.length) {
    return () => 0;
  }

  const q1 = quantile(nonZero, 0.25);
  const q2 = quantile(nonZero, 0.5);
  const q3 = quantile(nonZero, 0.75);

  const threshold1 = Math.max(1, q1);
  const threshold2 = Math.max(threshold1 + 1, q2);
  const threshold3 = Math.max(threshold2 + 1, q3);

  return (count) => {
    const value = Number(count || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value < threshold1) return 1;
    if (value < threshold2) return 2;
    if (value < threshold3) return 3;
    return 4;
  };
}

function formatMonthLabel(isoDate) {
  const parsed = new Date(isoDate + "T00:00:00.000Z");
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

function buildMonthLabels({
  range = "yearly",
  startDate,
  weeks = YEARLY_WEEKS,
  gridX = 0,
  weekWidth = 1,
  gridWidth = 0,
} = {}) {
  const monthBoundaries = [];
  let previousMonthKey = "";

  for (let week = 0; week < weeks; week += 1) {
    const weekDate = new Date(startDate.getTime() + week * 7 * DAY_MS);
    const isoWeekDate = toIsoDate(weekDate);
    const monthKey = isoWeekDate.slice(0, 7);

    if (!previousMonthKey || monthKey !== previousMonthKey) {
      monthBoundaries.push({
        monthKey,
        label: formatMonthLabel(isoWeekDate),
        x: gridX + week * weekWidth,
      });
      previousMonthKey = monthKey;
    }
  }

  if (range !== "monthly") {
    return monthBoundaries.map((entry) => ({
      x: entry.x,
      label: entry.label,
      textAnchor: "start",
    }));
  }

  const recentDistinct = [];
  for (
    let index = monthBoundaries.length - 1;
    index >= 0 && recentDistinct.length < 2;
    index -= 1
  ) {
    const entry = monthBoundaries[index];
    if (!entry?.label) continue;
    if (recentDistinct.some((candidate) => candidate.monthKey === entry.monthKey)) {
      continue;
    }
    recentDistinct.push(entry);
  }

  const selectedMonths = recentDistinct.reverse();
  if (!selectedMonths.length) return [];
  if (selectedMonths.length === 1) {
    return [{ x: gridX, label: selectedMonths[0].label, textAnchor: "start" }];
  }

  return [
    {
      x: gridX,
      label: selectedMonths[0].label,
      textAnchor: "start",
    },
    {
      x: gridX + gridWidth,
      label: selectedMonths[1].label,
      textAnchor: "end",
    },
  ];
}

function renderHeatmapSvg({
  username,
  days,
  variant,
  range,
  stickers = {},
  stickerLayers = [],
  stickerHrefs = {},
}) {
  const theme = VARIANTS[variant] || VARIANTS.classic;
  const normalizedRange = normalizeRange(range);
  const effectiveRange = normalizedRange;
  const weeks = effectiveRange === "monthly" ? MONTHLY_WEEKS : YEARLY_WEEKS;
  const rangeLabel = effectiveRange === "monthly" ? "Last 30 Days" : "Last 12 Months";
  const normalizedDays = new Map();

  days.forEach((entry) => {
    const isoDate = toIsoDate(entry?.date);
    const count = Number(entry?.count || 0);
    if (!isoDate || !Number.isFinite(count) || count < 0) return;
    normalizedDays.set(isoDate, Math.floor(count));
  });

  const levelFor = buildLevelResolver([...normalizedDays.values()]);

  const today = new Date();
  const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const rawStart = new Date(endDate.getTime() - (weeks - 1) * 7 * DAY_MS);
  const startDate = startOfWeek(rawStart);

  const paddingX = 22;
  const paddingY = 18;
  const cell = 10;
  const gap = 3;
  const weekWidth = cell + gap;
  const gridWidth = weeks * weekWidth - gap;
  const gridHeight = 7 * (cell + gap) - gap;
  const leftLabelSpace = 52;
  const targetWidth = effectiveRange === "monthly" ? 560 : 1120;
  const width = Math.max(targetWidth, paddingX + leftLabelSpace + gridWidth + paddingX);
  const gridX = Math.max(Math.floor((width - gridWidth) / 2), paddingX + leftLabelSpace);

  const titleY = paddingY + 12;
  const subtitleY = titleY + 18;
  const monthY = subtitleY + 18;
  const gridY = monthY + 12;
  const legendY = gridY + gridHeight + 24;
  const minHeight = legendY + paddingY + 6;
  const targetHeight = effectiveRange === "monthly" ? 228 : 320;
  const height = Math.max(targetHeight, minHeight);
  const yShift = Math.floor((height - minHeight) / 2);
  const shiftedTitleY = titleY + yShift;
  const shiftedSubtitleY = subtitleY + yShift;
  const shiftedMonthY = monthY + yShift;
  const shiftedGridY = gridY + yShift;
  const shiftedLegendY = legendY + yShift;
  const dayLabelX = gridX - 40;

  const cells = [];
  const monthLabels = buildMonthLabels({
    range: effectiveRange,
    startDate,
    weeks,
    gridX,
    weekWidth,
    gridWidth,
  });

  for (let week = 0; week < weeks; week += 1) {
    const weekDate = new Date(startDate.getTime() + week * 7 * DAY_MS);

    for (let day = 0; day < 7; day += 1) {
      const date = new Date(weekDate.getTime() + day * DAY_MS);
      if (date > endDate) continue;

      const isoDate = toIsoDate(date);
      const count = Number(normalizedDays.get(isoDate) || 0);
      const level = levelFor(count);
      const fill = theme.levels[Math.max(0, Math.min(level, theme.levels.length - 1))];

      cells.push({
        x: gridX + week * weekWidth,
        y: shiftedGridY + day * (cell + gap),
        fill,
        isoDate,
        count,
      });
    }
  }

  const monthText = monthLabels
    .map(
      (entry) =>
        `<text x="${entry.x}" y="${shiftedMonthY}" fill="${theme.month}" font-size="10" ${
          entry.textAnchor === "end" ? 'text-anchor="end"' : ""
        } font-family="Inter, Segoe UI, sans-serif">${escapeXml(entry.label)}</text>`
    )
    .join("");

  const dayLabels = [
    { label: "Mon", day: 1 },
    { label: "Wed", day: 3 },
    { label: "Fri", day: 5 },
  ]
    .map((entry) => {
      const y = shiftedGridY + entry.day * (cell + gap) + 8;
      return `<text x="${dayLabelX}" y="${y}" fill="${theme.dayLabel}" font-size="10" font-family="Inter, Segoe UI, sans-serif">${entry.label}</text>`;
    })
    .join("");

  const cellsMarkup = cells
    .map(
      (entry) =>
        `<rect x="${entry.x}" y="${entry.y}" width="${cell}" height="${cell}" rx="2.4" fill="${entry.fill}"><title>${entry.isoDate}: ${entry.count} contribution${entry.count === 1 ? "" : "s"}</title></rect>`
    )
    .join("");

  const legendStartX = gridX + gridWidth - 4 * (cell + gap) - 104;
  const tortoiseDecoration = "";
  const cardFill = variant === "tortoise" ? theme.bg : "none";
  const legendCells = theme.levels
    .map(
      (fill, index) =>
        `<rect x="${legendStartX + 64 + index * (cell + gap)}" y="${shiftedLegendY - cell + 1}" width="${cell}" height="${cell}" rx="2" fill="${fill}" />`
    )
    .join("");

  const svgMarkup = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Contribution graph for ${escapeXml(username)}">
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="12" fill="${cardFill}" stroke="${theme.border}" />
  <text x="${paddingX}" y="${shiftedTitleY}" fill="${theme.title}" font-size="16" font-family="Inter, Segoe UI, sans-serif" font-weight="700">Contribution Graph</text>
  <text x="${paddingX}" y="${shiftedSubtitleY}" fill="${theme.subtitle}" font-size="12" font-family="Inter, Segoe UI, sans-serif">@${escapeXml(username)}</text>
  <text x="${width - paddingX}" y="${shiftedSubtitleY}" fill="${theme.subtitle}" font-size="11" text-anchor="end" font-family="Inter, Segoe UI, sans-serif">${rangeLabel}</text>
  ${monthText}
  ${dayLabels}
  ${cellsMarkup}
  <text x="${legendStartX}" y="${shiftedLegendY}" fill="${theme.legend}" font-size="10" font-family="Inter, Segoe UI, sans-serif">Less</text>
  ${legendCells}
  <text x="${legendStartX + 64 + 5 * (cell + gap)}" y="${shiftedLegendY}" fill="${theme.legend}" font-size="10" font-family="Inter, Segoe UI, sans-serif">More</text>
  ${tortoiseDecoration}
</svg>`.trim();

  const layerOverlay = buildLayerStickerOverlay({
    stickerLayers,
    width,
    height,
    hrefMap: stickerHrefs,
  });
  if (layerOverlay) {
    return appendStickerOverlay(svgMarkup, layerOverlay);
  }

  const slotOverlay = buildSlotStickerOverlay({
    stickers,
    range: effectiveRange,
    width,
    height,
    hrefMap: stickerHrefs,
  });
  return appendStickerOverlay(svgMarkup, slotOverlay);
}

async function fetchContributionDays({ token, username }) {
  const now = new Date();
  const from = new Date(now.getTime() - 366 * DAY_MS);

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: {
        login: username,
        from: from.toISOString(),
        to: now.toISOString(),
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.errors?.length) {
    const message =
      payload?.errors?.[0]?.message ||
      payload?.message ||
      "Failed to fetch contribution calendar";
    throw new Error(message);
  }

  const weeks = payload?.data?.user?.contributionsCollection?.contributionCalendar?.weeks || [];
  return weeks
    .flatMap((week) => (Array.isArray(week?.contributionDays) ? week.contributionDays : []))
    .map((entry) => ({
      date: toIsoDate(entry?.date),
      count: Number(entry?.contributionCount || 0),
    }))
    .filter((entry) => entry.date);
}

async function loadGraphConfigs({
  configPath,
  fallbackUsername,
  fallbackVariant,
  fallbackRange,
  fallbackOutputPath,
} = {}) {
  const normalizedPath = String(configPath || "").trim();
  const buildFallbackEntry = () =>
    normalizeGraphEntry({
      username: fallbackUsername,
      variant: fallbackVariant,
      range: fallbackRange,
      outputPath: fallbackOutputPath,
    });

  if (!normalizedPath) {
    return buildFallbackEntry() ? [buildFallbackEntry()] : [];
  }

  try {
    const absoluteConfigPath = path.resolve(process.cwd(), normalizedPath);
    const raw = await fs.readFile(absoluteConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return buildFallbackEntry() ? [buildFallbackEntry()] : [];
    }

    let graphs = [];

    if (Array.isArray(parsed?.graphs)) {
      graphs = parsed.graphs
        .map((entry) =>
          normalizeGraphEntry(entry, {
            username: fallbackUsername,
            variant: fallbackVariant,
            range: fallbackRange,
            outputPath: fallbackOutputPath,
          })
        )
        .filter(Boolean);
    } else if (parsed?.graphs && typeof parsed.graphs === "object") {
      graphs = Object.entries(parsed.graphs)
        .map(([rangeKey, entry]) =>
          normalizeGraphEntry(entry, {
            username: fallbackUsername,
            variant: fallbackVariant,
            range: rangeKey,
            outputPath:
              normalizeRange(rangeKey) === "monthly"
                ? "assets/readme/contribution-graph-monthly.svg"
                : "assets/readme/contribution-graph.svg",
          })
        )
        .filter(Boolean);
    }

    if (!graphs.length) {
      graphs = ["yearly", "monthly"]
        .map((rangeKey) =>
          normalizeGraphEntry(parsed?.[rangeKey], {
            username: fallbackUsername,
            variant: fallbackVariant,
            range: rangeKey,
            outputPath:
              normalizeRange(rangeKey) === "monthly"
                ? "assets/readme/contribution-graph-monthly.svg"
                : "assets/readme/contribution-graph.svg",
          })
        )
        .filter(Boolean);
    }

    if (!graphs.length) {
      const fallbackEntry = buildFallbackEntry();
      return fallbackEntry ? [fallbackEntry] : [];
    }

    const deduped = new Map();
    graphs.forEach((entry) => {
      deduped.set(entry.outputPath, entry);
    });
    return [...deduped.values()];
  } catch {
    const fallbackEntry = buildFallbackEntry();
    return fallbackEntry ? [fallbackEntry] : [];
  }
}

function normalizeGraphEntry(entry, fallback = {}) {
  if (!entry || typeof entry !== "object") return null;

  const outputPath = String(
    entry?.outputPath || entry?.assetPath || fallback.outputPath || ""
  ).trim();
  if (!outputPath) return null;

  return {
    id: String(entry?.id || outputPath).trim() || outputPath,
    username: normalizeUsername(entry?.username || fallback.username),
    variant: normalizeVariant(entry?.variant || fallback.variant),
    range: normalizeRange(entry?.range || fallback.range),
    outputPath,
    stickers: normalizeStickerAssignments(entry?.stickers || fallback.stickers),
    stickerLayers: normalizeStickerLayers(
      entry?.stickerLayers || fallback.stickerLayers
    ),
    stickerHrefs:
      entry?.stickerHrefs && typeof entry.stickerHrefs === "object"
        ? entry.stickerHrefs
        : fallback?.stickerHrefs && typeof fallback.stickerHrefs === "object"
          ? fallback.stickerHrefs
          : {},
  };
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

async function main() {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  const fallbackUsername = normalizeUsername(
    process.env.GITHUB_USERNAME ||
      process.env.GITHUB_REPOSITORY_OWNER ||
      process.env.GITHUB_ACTOR ||
      ""
  );
  const fallbackVariant = normalizeVariant(process.env.GRAPH_VARIANT || "classic");
  const fallbackRange = normalizeRange(process.env.GRAPH_RANGE || "yearly");
  const fallbackOutputPath = String(
    process.env.GRAPH_OUTPUT_PATH || "assets/readme/contribution-graph.svg"
  ).trim();
  const configPath = String(process.env.GRAPH_CONFIG_PATH || "assets/readme/contribution-graph.config.json").trim();

  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const graphConfigs = await loadGraphConfigs({
    configPath,
    fallbackUsername,
    fallbackVariant,
    fallbackRange,
    fallbackOutputPath,
  });

  if (!graphConfigs.length) {
    throw new Error("No contribution graph entries configured");
  }

  const daysByUsername = new Map();
  const updatedOutputs = [];

  for (const graphConfig of graphConfigs) {
    const graphUsername = normalizeUsername(graphConfig.username || fallbackUsername);
    if (!graphUsername) {
      throw new Error("Missing GitHub username for " + graphConfig.outputPath);
    }

    let days = daysByUsername.get(graphUsername);
    if (!days) {
      days = await fetchContributionDays({ token, username: graphUsername });
      daysByUsername.set(graphUsername, days);
    }

    const svg = renderHeatmapSvg({
      username: graphUsername,
      days,
      variant: graphConfig.variant,
      range: graphConfig.range,
      stickers: graphConfig.stickers,
      stickerLayers: graphConfig.stickerLayers,
      stickerHrefs: graphConfig.stickerHrefs,
    });

    const absoluteOutputPath = path.resolve(process.cwd(), graphConfig.outputPath);
    await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await fs.writeFile(absoluteOutputPath, svg + "
", "utf8");
    updatedOutputs.push(graphConfig.outputPath);
  }

  console.log("Contribution graphs updated: " + updatedOutputs.join(", "));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});