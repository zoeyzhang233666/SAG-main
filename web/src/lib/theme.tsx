import { useEffect, useState } from "react";

/**
 * 应用主题系统（白天 / 夜间 + 可自定义配色）。
 *
 * - 自成一体：把状态存进 localStorage，并把对应的 CSS 变量写到 <html> 上。
 * - 任何组件用 useTheme() 即可读取/修改主题，并在主题变化时自动重渲染。
 * - styles.css 里的颜色都引用这些 CSS 变量，所以改一处即可全局生效。
 */

export type ThemeMode = "light" | "dark" | "auto";
export type ResolvedMode = "light" | "dark";

export type ThemeColors = {
  /** 页面大背景色（之前那一大片淡灰蓝就是它） */
  background: string;
  /** 主强调色（按钮、高亮、链接等） */
  accent: string;
  /** 卡片 / 面板表面色 */
  card: string;
  /** 边框 / 分隔线颜色 */
  border: string;
};

export type ThemeState = {
  mode: ThemeMode;
  light: ThemeColors;
  dark: ThemeColors;
};

export type ThemePreset = {
  id: string;
  label: { zh: string; en: string };
  light: ThemeColors;
  dark: ThemeColors;
};

const STORAGE_KEY = "sag:theme:v2";

const DEFAULT_LIGHT: ThemeColors = {
  background: "#f5f6f8",
  accent: "#df5b25",
  card: "#ffffff",
  border: "#e4e7ec"
};

const DEFAULT_DARK: ThemeColors = {
  background: "#0e1116",
  accent: "#ff7a45",
  card: "#171b22",
  border: "#2a313c"
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "default",
    label: { zh: "经典橙", en: "Classic" },
    light: DEFAULT_LIGHT,
    dark: DEFAULT_DARK
  },
  {
    id: "graphite",
    label: { zh: "石墨灰", en: "Graphite" },
    light: { background: "#f4f5f7", accent: "#3b6fe0", card: "#ffffff", border: "#e2e6ec" },
    dark: { background: "#0c0d10", accent: "#6f9bff", card: "#16181d", border: "#272a31" }
  },
  {
    id: "warm",
    label: { zh: "暖砂", en: "Warm sand" },
    light: { background: "#f6f3ee", accent: "#c2602f", card: "#fffdf9", border: "#e8e1d6" },
    dark: { background: "#13110e", accent: "#e8895a", card: "#1e1a15", border: "#322c24" }
  },
  {
    id: "teal",
    label: { zh: "青墨", en: "Teal ink" },
    light: { background: "#eef3f3", accent: "#0f8b8d", card: "#ffffff", border: "#dde7e7" },
    dark: { background: "#0a1213", accent: "#39b3b5", card: "#13191a", border: "#243031" }
  },
  {
    id: "indigo",
    label: { zh: "靛蓝", en: "Indigo" },
    light: { background: "#f1f2f9", accent: "#4f46e5", card: "#ffffff", border: "#e0e2ef" },
    dark: { background: "#0b0c14", accent: "#8b85ff", card: "#14151f", border: "#262838" }
  },
  {
    id: "violet",
    label: { zh: "霓虹紫", en: "Neon violet" },
    light: { background: "#f5f1fb", accent: "#7c3aed", card: "#ffffff", border: "#e8dffa" },
    dark: { background: "#0d0a16", accent: "#a974ff", card: "#181122", border: "#2c2140" }
  },
  {
    id: "rose",
    label: { zh: "绯红", en: "Rose" },
    light: { background: "#fbf1f3", accent: "#e11d48", card: "#ffffff", border: "#f4dbe1" },
    dark: { background: "#140a0d", accent: "#ff5d7c", card: "#1f1216", border: "#3a232b" }
  },
  {
    id: "forest",
    label: { zh: "松绿", en: "Forest" },
    light: { background: "#eef4ee", accent: "#16a34a", card: "#ffffff", border: "#dce8dc" },
    dark: { background: "#0a120c", accent: "#3fd07a", card: "#121a14", border: "#223027" }
  },
  {
    id: "amber",
    label: { zh: "琥珀", en: "Amber" },
    light: { background: "#f8f4ea", accent: "#d97706", card: "#fffdf7", border: "#ece2cf" },
    dark: { background: "#13100a", accent: "#f5a623", card: "#1d1810", border: "#322a1c" }
  },
  {
    id: "midnight",
    label: { zh: "午夜蓝", en: "Midnight" },
    light: { background: "#eef1f6", accent: "#0369a1", card: "#ffffff", border: "#dde4ee" },
    dark: { background: "#070b12", accent: "#38bdf8", card: "#0f141d", border: "#1e2733" }
  },
  {
    id: "mono",
    label: { zh: "极简灰", en: "Mono" },
    light: { background: "#f5f5f4", accent: "#1c1917", card: "#ffffff", border: "#e7e5e4" },
    dark: { background: "#0a0a0a", accent: "#e5e5e5", card: "#161616", border: "#2a2a2a" }
  }
];

const DEFAULT_STATE: ThemeState = { mode: "auto", light: { ...DEFAULT_LIGHT }, dark: { ...DEFAULT_DARK } };

let state: ThemeState = loadState();
const listeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;

function loadState(): ThemeState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    return {
      mode: parsed.mode === "light" || parsed.mode === "dark" ? parsed.mode : "auto",
      light: { ...DEFAULT_LIGHT, ...(parsed.light ?? {}) },
      dark: { ...DEFAULT_DARK, ...(parsed.dark ?? {}) }
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 不可用时忽略
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveMode(mode: ThemeMode): ResolvedMode {
  return mode === "auto" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

/* ---------- 颜色工具 ---------- */

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  let value = hex.trim().replace("#", "");
  if (value.length === 3) {
    value = value.split("").map((c) => c + c).join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const num = Number.parseInt(value, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

/** hex -> "H S% L%"（给 shadcn 的 hsl(var(--x)) 用） */
function hexToHslTriplet(hex: string): string {
  const rgb = parseHex(hex) ?? { r: 223, g: 91, b: 37 };
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return `rgba(0,0,0,${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** 把一个颜色按比例向白/黑靠拢（mix），用于派生表面层次 */
export function mixHex(hex: string, target: "#ffffff" | "#000000", ratio: number): string {
  const a = parseHex(hex);
  const b = parseHex(target);
  if (!a || !b) return hex;
  const r = Math.round(a.r + (b.r - a.r) * ratio);
  const g = Math.round(a.g + (b.g - a.g) * ratio);
  const bl = Math.round(a.b + (b.b - a.b) * ratio);
  return `#${[r, g, bl].map((v) => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex) ?? { r: 255, g: 255, b: 255 };
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** 根据背景明暗选黑/白前景 */
function readableInk(hex: string, dark: boolean): string {
  const lum = relativeLuminance(hex);
  if (dark) return lum > 0.5 ? "#141821" : "#e8edf5";
  return lum < 0.5 ? "#f4f6fa" : "#18243a";
}

/* ---------- 应用到 <html> ---------- */

function applyToDocument() {
  if (typeof document === "undefined") return;
  const resolved = resolveMode(state.mode);
  const colors = resolved === "dark" ? state.dark : state.light;
  const root = document.documentElement;
  const dark = resolved === "dark";

  root.classList.toggle("dark", dark);
  root.dataset.theme = resolved;
  root.style.colorScheme = dark ? "dark" : "light";

  const ink = readableInk(colors.card, dark);
  const inkMuted = dark ? mixHex(ink, "#000000", 0.34) : mixHex(ink, "#ffffff", 0.42);

  // 派生的表面层次
  const panel = dark ? mixHex(colors.card, "#ffffff", 0.02) : colors.card;
  const inset = dark ? mixHex(colors.card, "#ffffff", 0.05) : mixHex(colors.card, "#000000", 0.03);
  const glass = hexToRgba(colors.card, dark ? 0.62 : 0.78);
  const elevated = dark ? mixHex(colors.card, "#ffffff", 0.04) : colors.card;

  const vars: Record<string, string> = {
    // shadcn token（HSL 三元组）
    "--background": hexToHslTriplet(colors.background),
    "--foreground": hexToHslTriplet(ink),
    "--muted": hexToHslTriplet(inset),
    "--muted-foreground": hexToHslTriplet(inkMuted),
    "--primary": hexToHslTriplet(colors.accent),
    "--primary-foreground": hexToHslTriplet(readableInk(colors.accent, false) === "#18243a" ? "#ffffff" : "#ffffff"),
    "--accent": hexToHslTriplet(dark ? mixHex(colors.accent, "#000000", 0.6) : mixHex(colors.accent, "#ffffff", 0.86)),
    "--accent-foreground": hexToHslTriplet(colors.accent),
    "--border": hexToHslTriplet(colors.border),
    "--input": hexToHslTriplet(colors.border),
    "--ring": hexToHslTriplet(colors.accent),
    // 直接的 hex / rgba 语义变量（styles.css 与图谱节点共用）
    "--chem-canvas": colors.background,
    "--chem-orange": colors.accent,
    "--chem-ink": ink,
    "--chem-surface": glass,
    "--surface-page": colors.background,
    "--surface-raised": elevated,
    "--surface-panel": panel,
    "--surface-inset": inset,
    "--surface-glass": glass,
    "--hairline": colors.border,
    "--accent-color": colors.accent,
    "--accent-soft": hexToRgba(colors.accent, dark ? 0.2 : 0.12),
    "--accent-softer": hexToRgba(colors.accent, dark ? 0.12 : 0.06),
    "--text-strong": ink,
    "--text": ink,
    "--text-muted": inkMuted,
    "--shadow-strong": dark ? "rgba(0,0,0,0.55)" : "rgba(24,36,58,0.12)",
    "--shadow-soft": dark ? "rgba(0,0,0,0.4)" : "rgba(24,36,58,0.07)"
  };

  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

function notify() {
  applyToDocument();
  persist();
  for (const listener of listeners) listener();
}

/* ---------- 公共操作 ---------- */

export function setThemeMode(mode: ThemeMode) {
  state = { ...state, mode };
  notify();
}

export function cycleThemeMode() {
  const order: ThemeMode[] = ["light", "dark", "auto"];
  const next = order[(order.indexOf(state.mode) + 1) % order.length];
  setThemeMode(next);
}

export function setThemeColor(mode: ResolvedMode, key: keyof ThemeColors, value: string) {
  state = { ...state, [mode]: { ...state[mode], [key]: value } };
  notify();
}

export function applyThemePreset(id: string) {
  const preset = THEME_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  state = { ...state, light: { ...preset.light }, dark: { ...preset.dark } };
  notify();
}

export function resetThemeColors() {
  state = { ...state, light: { ...DEFAULT_LIGHT }, dark: { ...DEFAULT_DARK } };
  notify();
}

/* ---------- 初始化（尽早调用，避免闪烁） ---------- */

let initialized = false;
export function initTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  applyToDocument();
  if (window.matchMedia) {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (state.mode === "auto") notify();
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener("change", onChange);
    else mediaQuery.addListener(onChange);
  }
}

initTheme();

/* ---------- React hook ---------- */

export function useTheme() {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const resolved = resolveMode(state.mode);
  return {
    mode: state.mode,
    resolved,
    isDark: resolved === "dark",
    light: state.light,
    dark: state.dark,
    colors: resolved === "dark" ? state.dark : state.light,
    setMode: setThemeMode,
    cycleMode: cycleThemeMode,
    setColor: setThemeColor,
    applyPreset: applyThemePreset,
    reset: resetThemeColors,
    presets: THEME_PRESETS
  };
}
