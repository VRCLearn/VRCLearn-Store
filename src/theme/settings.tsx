import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import "@material/web/dialog/dialog.js";
import "@material/web/slider/slider.js";
import type { MdDialog } from "@material/web/dialog/dialog.js";
import type { MdSlider } from "@material/web/slider/slider.js";
import "@material/web/chips/chip-set.js";
import type { Locale } from "../../shared/contracts";
import { Button, Field, FilterChip, MaterialSelect } from "../material";
import { DEFAULT_THEME, isThemeScheme, normalizeHex, THEME_SCHEMES, type ThemeMode } from "./core";
import { useStoreTheme } from "./provider";
import "./theme.css";

const copy = {
    en: {
        title: "Appearance", introduction: "Choose a color and make the store feel like yours.", mode: "Display mode", system: "Use device setting", light: "Light", dark: "Dark", color: "Theme color", chooseColor: "Choose theme color", hex: "Color value", hexHint: "For example, #6cb6ff", invalidColor: "Enter a six-digit color such as #6cb6ff.", scheme: "Color style", precise: "Fine-tune color", hue: "Hue", chroma: "Colorfulness", tone: "Lightness", reset: "Reset appearance", done: "Done",
        schemes: ["Soft", "True to color", "Monochrome", "Neutral", "Vibrant", "Expressive", "Content", "Rainbow", "Fruit salad"]
    },
    "zh-CN": {
        title: "外观", introduction: "选择喜欢的颜色，让商店更合你的心意。", mode: "显示模式", system: "跟随系统", light: "浅色", dark: "深色", color: "主题颜色", chooseColor: "选择主题颜色", hex: "颜色值", hexHint: "例如 #6cb6ff", invalidColor: "请输入六位颜色值，例如 #6cb6ff。", scheme: "配色风格", precise: "精细调整颜色", hue: "色相", chroma: "鲜艳度", tone: "明度", reset: "恢复默认外观", done: "完成",
        schemes: ["柔和", "忠实原色", "黑白", "中性", "鲜明", "活泼", "内容", "彩虹", "果色"]
    },
    ja: {
        title: "外観", introduction: "好きな色で、ストアを自分らしく。", mode: "表示モード", system: "端末の設定に合わせる", light: "ライト", dark: "ダーク", color: "テーマカラー", chooseColor: "テーマカラーを選ぶ", hex: "カラー値", hexHint: "例：#6cb6ff", invalidColor: "#6cb6ff のように6桁のカラー値を入力してください。", scheme: "配色スタイル", precise: "色を細かく調整", hue: "色相", chroma: "鮮やかさ", tone: "明るさ", reset: "外観をリセット", done: "完了",
        schemes: ["ソフト", "原色に忠実", "モノクロ", "ニュートラル", "鮮やか", "表情豊か", "コンテンツ", "レインボー", "フルーツサラダ"]
    }
} satisfies Record<Locale, { title: string; introduction: string; mode: string; system: string; light: string; dark: string; color: string; chooseColor: string; hex: string; hexHint: string; invalidColor: string; scheme: string; precise: string; hue: string; chroma: string; tone: string; reset: string; done: string; schemes: string[] }>;

function ColorSlider({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (value: number) => void }) {
    const ref = useRef<MdSlider>(null);
    useLayoutEffect(() => {
        if (ref.current && ref.current.value !== value) ref.current.value = value;
    });
    return <div className="theme-slider-row"><div className="theme-slider-label"><span>{label}</span><output>{value}</output></div>{createElement("md-slider", { ref, min: 0, max, step: 1, value, labeled: true, "aria-label": label, onInput: () => onChange(ref.current?.value ?? value) })}</div>;
}

export function ThemeSettings({ open, onClose, locale }: { open: boolean; onClose: () => void; locale: Locale }) {
    const theme = useStoreTheme();
    const t = copy[locale];
    const ref = useRef<MdDialog>(null);
    const [hex, setHex] = useState(theme.preferences.source);
    useEffect(() => { setHex(theme.preferences.source); }, [theme.preferences.source]);
    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        dialog.open = open;
        if (open) setHex(theme.preferences.source);
    }, [open]);
    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        dialog.addEventListener("closed", onClose);
        return () => dialog.removeEventListener("closed", onClose);
    }, [onClose]);
    const invalid = hex.trim().length >= 7 && !normalizeHex(hex);
    const modes: { value: ThemeMode; icon: string; label: string }[] = [{ value: "light", icon: "light_mode", label: t.light }, { value: "system", icon: "contrast", label: t.system }, { value: "dark", icon: "dark_mode", label: t.dark }];
    return createElement("md-dialog", { ref, className: "theme-dialog", "aria-label": t.title },
        <span slot="headline">{t.title}</span>,
        <div slot="content" className="theme-settings-content">
            <p>{t.introduction}</p>
            <section className="theme-setting-section" aria-label={t.mode}>
                <h3>{t.mode}</h3>
                {createElement("md-chip-set", { "aria-label": t.mode }, modes.map((mode) => <FilterChip key={mode.value} label={mode.label} icon={mode.icon} selected={theme.preferences.mode === mode.value} onClick={() => theme.setMode(mode.value)} />))}
            </section>
            <section className="theme-setting-section" aria-label={t.color}>
                <h3>{t.color}</h3>
                <div className="theme-color-fields"><Field label={t.hex} value={hex} maxLength={7} supportingText={invalid ? t.invalidColor : t.hexHint} error={Boolean(invalid)} onChange={(value) => { setHex(value); if (/^#[0-9a-f]{6}$/i.test(value.trim())) theme.setSource(value); }} /><input type="color" aria-label={t.chooseColor} value={theme.preferences.source} onInput={(event) => theme.setSource(event.currentTarget.value)} /></div>
                <MaterialSelect label={t.scheme} value={theme.preferences.scheme} options={THEME_SCHEMES.map((scheme, index) => ({ value: scheme, label: t.schemes[index] }))} onChange={(value) => { if (isThemeScheme(value)) theme.setScheme(value); }} />
            </section>
            <details className="theme-fine-controls"><summary>{t.precise}</summary><div className="theme-slider-list"><ColorSlider label={t.hue} value={theme.sourceHct.hue} max={360} onChange={(value) => theme.setHct("hue", value)} /><ColorSlider label={t.chroma} value={theme.sourceHct.chroma} max={150} onChange={(value) => theme.setHct("chroma", value)} /><ColorSlider label={t.tone} value={theme.sourceHct.tone} max={100} onChange={(value) => theme.setHct("tone", value)} /></div></details>
        </div>,
        <div slot="actions"><Button variant="text" onClick={() => { theme.reset(); setHex(DEFAULT_THEME.source); }}>{t.reset}</Button><Button onClick={onClose}>{t.done}</Button></div>
    );
}
