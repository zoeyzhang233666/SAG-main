import { Moon, Sun, SunMoon, RotateCcw } from "lucide-react";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { useTheme, type ResolvedMode, type ThemeColors } from "../lib/theme";

/** 顶栏上的一键切换按钮（白天 → 夜间 → 跟随系统 循环） */
export function ThemeToggleButton({ className }: { className?: string }) {
  const { t } = useI18n();
  const { mode, isDark, cycleMode } = useTheme();
  const Icon = mode === "auto" ? SunMoon : isDark ? Moon : Sun;
  const label =
    mode === "auto"
      ? t("跟随系统", "Follow system")
      : isDark
        ? t("夜间模式", "Dark mode")
        : t("白天模式", "Light mode");
  return (
    <button
      type="button"
      onClick={cycleMode}
      title={`${t("外观", "Appearance")}：${label}`}
      aria-label={label}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/70 text-muted-foreground transition hover:text-foreground hover:border-primary/40",
        className
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

const COLOR_FIELDS: Array<{ key: keyof ThemeColors; zh: string; en: string }> = [
  { key: "background", zh: "背景色", en: "Background" },
  { key: "accent", zh: "强调色", en: "Accent" },
  { key: "card", zh: "卡片/面板", en: "Card / panel" },
  { key: "border", zh: "边框/分隔线", en: "Border / divider" }
];

/** 设置页里的「外观」卡片 */
export function ThemeSettingsCard() {
  const { t } = useI18n();
  const { mode, setMode, presets, applyPreset, light, dark, setColor, reset } = useTheme();

  const modeOptions: Array<{ value: typeof mode; label: string }> = [
    { value: "light", label: t("白天", "Light") },
    { value: "dark", label: t("夜间", "Dark") },
    { value: "auto", label: t("跟随系统", "Auto") }
  ];

  return (
    <section className="chem-settings-card rounded-2xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">APPEARANCE</div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">{t("外观与配色", "Appearance & colors")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("切换白天 / 夜间模式，并自定义页面背景与强调色。", "Switch light / dark mode and customize the page background and accent.")}
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("恢复默认", "Reset")}
        </button>
      </div>

      {/* 模式切换 */}
      <div className="mb-4 space-y-2">
        <div className="text-sm font-medium text-foreground">{t("显示模式", "Display mode")}</div>
        <div className="flex w-fit flex-wrap gap-1 rounded-xl border border-border bg-background p-1">
          {modeOptions.map((option) => {
            const ModeIcon = option.value === "auto" ? SunMoon : option.value === "dark" ? Moon : Sun;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                className={cn(
                  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-4 py-1.5 text-sm text-muted-foreground transition hover:text-foreground",
                  mode === option.value && "bg-foreground text-background shadow-sm hover:text-background"
                )}
              >
                <ModeIcon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 预设主题 */}
      <div className="mb-4 space-y-2">
        <div className="text-sm font-medium text-foreground">{t("配色预设", "Color presets")}</div>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.id)}
              className="group flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground transition hover:border-primary/50"
            >
              <span className="flex -space-x-1">
                <span className="h-4 w-4 rounded-full border border-white/60 shadow-sm" style={{ background: preset.light.accent }} />
                <span className="h-4 w-4 rounded-full border border-white/20 shadow-sm" style={{ background: preset.dark.background }} />
              </span>
              {t(preset.label.zh, preset.label.en)}
            </button>
          ))}
        </div>
      </div>

      {/* 分模式自定义颜色 */}
      <div className="grid gap-4 md:grid-cols-2">
        <ColorGroup title={t("白天模式配色", "Light mode colors")} mode="light" colors={light} onChange={setColor} />
        <ColorGroup title={t("夜间模式配色", "Dark mode colors")} mode="dark" colors={dark} onChange={setColor} />
      </div>
    </section>
  );
}

function ColorGroup(props: {
  title: string;
  mode: ResolvedMode;
  colors: ThemeColors;
  onChange: (mode: ResolvedMode, key: keyof ThemeColors, value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="mb-2.5 text-xs font-semibold text-foreground">{props.title}</div>
      <div className="space-y-2">
        {COLOR_FIELDS.map((field) => (
          <label key={field.key} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t(field.zh, field.en)}</span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-[11px] uppercase text-muted-foreground">{props.colors[field.key]}</span>
              <input
                type="color"
                value={props.colors[field.key]}
                onChange={(event) => props.onChange(props.mode, field.key, event.target.value)}
                className="h-7 w-9 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
              />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
