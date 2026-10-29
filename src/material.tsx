import { createElement, useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/elevated-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/iconbutton/filled-tonal-icon-button.js";
import "@material/web/iconbutton/outlined-icon-button.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/chips/assist-chip.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/tabs/tabs.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/ripple/ripple.js";
import "@material/web/focus/md-focus-ring.js";
import "@material/web/labs/card/filled-card.js";
import type { MdOutlinedTextField } from "@material/web/textfield/outlined-text-field.js";
import type { MdOutlinedSelect } from "@material/web/select/outlined-select.js";
import { FocusState, type MdMenu } from "@material/web/menu/menu.js";
import type { MdTabs } from "@material/web/tabs/tabs.js";
import { Icon } from "./icons";
export { Icon } from "./icons";

export type ButtonVariant = "filled" | "tonal" | "outlined" | "text" | "elevated";
const buttonTag = (variant: ButtonVariant) => `md-${variant === "tonal" ? "filled-tonal" : variant}-button`;

export function Card({ children, ...props }: HTMLAttributes<HTMLElement>) {
    return createElement("md-filled-card", props, children);
}

export interface ButtonProps {
    children: ReactNode;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    variant?: ButtonVariant;
    icon?: string;
    className?: string;
    "aria-label"?: string;
    title?: string;
}

export function Button({ children, onClick, type = "button", disabled = false, variant = "filled", icon, ...rest }: ButtonProps) {
    return createElement(buttonTag(variant), { type, disabled, onClick, hasIcon: Boolean(icon), ...rest }, icon && <Icon name={icon} slot="icon" />, children);
}

export function LinkButton({ href, children, variant = "filled", icon, target, rel, className, "aria-label": label }: {
    href: string;
    children: ReactNode;
    variant?: ButtonVariant;
    icon?: string;
    target?: "_blank" | "_self";
    rel?: string;
    className?: string;
    "aria-label"?: string;
}) {
    return createElement(buttonTag(variant), { href, target, rel, className, hasIcon: Boolean(icon), "aria-label": label }, icon && <Icon name={icon} slot="icon" />, children);
}

export interface IconButtonProps {
    icon?: string;
    children?: ReactNode;
    label: string;
    onClick?: () => void;
    onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
    href?: string;
    variant?: "standard" | "tonal" | "outlined";
    disabled?: boolean;
    id?: string;
    className?: string;
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
    "aria-haspopup"?: "menu" | "dialog";
    "aria-description"?: string;
    "aria-pressed"?: boolean;
}

export function IconButton({ icon, children, label, variant = "standard", ...rest }: IconButtonProps) {
    const tag = variant === "tonal" ? "md-filled-tonal-icon-button" : variant === "outlined" ? "md-outlined-icon-button" : "md-icon-button";
    const controlled = rest["aria-pressed"] !== undefined;
    return createElement(tag, { type: "button", title: label, "aria-label": label, ...rest, "aria-expanded": rest["aria-expanded"] === undefined ? undefined : String(rest["aria-expanded"]), toggle: controlled, selected: rest["aria-pressed"], onClick: (event: MouseEvent) => {
        if (controlled) event.preventDefault();
        rest.onClick?.();
    } }, children ?? (icon && <Icon name={icon} />));
}

export function Field({ label, value, onChange, type = "text", required = false, disabled = false, multiline = false, maxLength, minLength, autoComplete, supportingText, name, leadingIcon, trailingIcon, placeholder, error, errorText, className, showCounter = false }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: string;
    required?: boolean;
    disabled?: boolean;
    multiline?: boolean;
    maxLength?: number;
    minLength?: number;
    autoComplete?: string;
    supportingText?: string;
    name?: string;
    leadingIcon?: string;
    trailingIcon?: string;
    placeholder?: string;
    error?: boolean;
    errorText?: string;
    className?: string;
    showCounter?: boolean;
}) {
    const field = useRef<MdOutlinedTextField | null>(null);
    useEffect(() => {
        if (field.current && field.current.value !== value) field.current.value = value;
    }, [value]);
    return createElement("md-outlined-text-field", {
        ref: field, label, value, type: multiline ? "textarea" : type, required, disabled, rows: multiline ? 5 : undefined,
        // maxLength also enables Material's counter. Use the public value property
        // to keep the input bounded without showing a counter on every short field.
        maxLength: showCounter ? maxLength : -1, minLength, autoComplete, name,
        supportingText, placeholder, error, errorText, className,
        hasLeadingIcon: Boolean(leadingIcon), hasTrailingIcon: Boolean(trailingIcon),
        onInput: (event: Event) => {
            const target = event.currentTarget;
            if (!(target instanceof HTMLElement) || !("value" in target) || typeof target.value !== "string") return;
            const next = maxLength === undefined ? target.value : target.value.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, "");
            if (target.value !== next) target.value = next;
            onChange(next);
        },
    }, leadingIcon && <Icon name={leadingIcon} slot="leading-icon" />, trailingIcon && <Icon name={trailingIcon} slot="trailing-icon" />);
}

export interface SelectOption { value: string; label: string; icon?: string; disabled?: boolean }

export function MaterialSelect({ label, value, onChange, options, required = false, disabled = false, className }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    required?: boolean;
    disabled?: boolean;
    className?: string;
}) {
    const select = useRef<MdOutlinedSelect | null>(null);
    useEffect(() => {
        const element = select.current;
        if (!element) return;
        const change = () => onChange(element.value);
        element.addEventListener("change", change);
        return () => element.removeEventListener("change", change);
    }, [onChange]);
    useEffect(() => {
        const element = select.current;
        if (element && element.value !== value) element.value = value;
    }, [value, options]);
    return createElement("md-outlined-select", { ref: select, label, value, required, disabled, menuPositioning: "popover", className, "aria-label": label },
        options.map((option) => createElement("md-select-option", { key: option.value, value: option.value, selected: option.value === value, disabled: option.disabled },
            option.icon && <Icon name={option.icon} slot="start" />, <span slot="headline">{option.label}</span>)));
}

export interface MenuOption { value: string; label: string; icon?: string; selected?: boolean }

export function MenuButton({ label, icon, items, onSelect, tonal = true }: {
    label: string;
    icon: string;
    items: MenuOption[];
    onSelect: (value: string) => void;
    tonal?: boolean;
}) {
    const generated = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const anchor = `menu-anchor-${generated}`;
    const menuId = `menu-${generated}`;
    const menu = useRef<MdMenu | null>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        const element = menu.current;
        if (!element) return;
        const opening = () => setOpen(true);
        const closing = () => setOpen(false);
        element.addEventListener("opening", opening);
        element.addEventListener("closed", closing);
        return () => {
            element.removeEventListener("opening", opening);
            element.removeEventListener("closed", closing);
        };
    }, []);
    useEffect(() => {
        const element = menu.current;
        if (!element) return;
        const select = (event: Event) => {
            const detail = (event as CustomEvent<{ initiator: HTMLElement; reason: { kind: string; key?: string } }>).detail;
            if (detail.reason.kind !== "click-selection" && !(detail.reason.kind === "keydown" && ["Enter", "Space"].includes(detail.reason.key ?? ""))) return;
            const value = detail.initiator.dataset.menuValue;
            if (value !== undefined) onSelect(value);
        };
        element.addEventListener("close-menu", select, true);
        return () => element.removeEventListener("close-menu", select, true);
    }, [onSelect]);
    function show(last = false) {
        const element = menu.current;
        if (!element) return;
        element.defaultFocus = last ? FocusState.LAST_ITEM : FocusState.FIRST_ITEM;
        element.show();
    }
    function toggle() { if (menu.current?.open) menu.current.close(); else show(); }
    function keyDown(event: ReactKeyboardEvent<HTMLElement>) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(event.key === "ArrowUp"); }
    }
    return <span className="material-menu-anchor">
        <IconButton id={anchor} label={label} icon={icon} variant={tonal ? "tonal" : "standard"} onClick={toggle} onKeyDown={keyDown} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-description={items.find((item) => item.selected)?.label} />
        {createElement("md-menu", { ref: menu, id: menuId, anchor, positioning: "popover", anchorCorner: "end-end", menuCorner: "start-end", "aria-label": label }, items.map((item) => createElement("md-menu-item", {
            key: item.value, type: "button", "data-menu-value": item.value, selected: Boolean(item.selected), "aria-selected": item.selected ? "true" : undefined,
        }, item.icon && <Icon name={item.icon} slot="start" />, <span slot="headline">{item.label}</span>, item.selected && <Icon name="check" slot="end" />)))}
    </span>;
}

export function FilterChip({ label, selected, onClick, icon, disabled = false }: { label: string; selected: boolean; onClick: () => void; icon?: string; disabled?: boolean }) {
    return createElement("md-filter-chip", { selected, disabled, hasIcon: Boolean(icon), onClick: (event: MouseEvent) => { event.preventDefault(); onClick(); } }, icon && <Icon name={icon} slot="icon" />, label);
}

export function NavigationChip({ label, href, icon }: { label: string; href: string; icon?: string }) {
    return createElement("md-assist-chip", { href, hasIcon: Boolean(icon) }, icon && <Icon name={icon} slot="icon" />, label);
}

/** Material Web supplies the state layers for project-specific cards and links. */
export function InteractionState({ inward = true }: { inward?: boolean }) {
    return <>{createElement("md-ripple")}{createElement("md-focus-ring", { inward })}</>;
}

export function Tabs({ tabs, value, onChange, label }: { tabs: { value: string; label: string; icon?: string }[]; value: string; onChange: (value: string) => void; label?: string }) {
    const element = useRef<MdTabs | null>(null);
    const activeTabIndex = Math.max(0, tabs.findIndex((tab) => tab.value === value));
    useEffect(() => {
        const current = element.current;
        if (!current) return;
        const change = () => { const tab = tabs[current.activeTabIndex]; if (tab) onChange(tab.value); };
        current.addEventListener("change", change);
        return () => current.removeEventListener("change", change);
    }, [tabs, onChange]);
    return createElement("md-tabs", { ref: element, activeTabIndex, "aria-label": label }, tabs.map((tab) => createElement("md-primary-tab", { key: tab.value, active: tab.value === value }, tab.icon && <Icon name={tab.icon} slot="icon" />, tab.label)));
}

export function List({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
    return createElement("md-list", { "aria-label": label, className }, children);
}

export function ListItem({ headline, supportingText, trailing, icon, selected, onClick, href, className, disabled = false }: {
    headline: string;
    supportingText?: string;
    trailing?: ReactNode;
    icon?: string;
    selected?: boolean;
    onClick?: () => void;
    href?: string;
    className?: string;
    disabled?: boolean;
}) {
    return createElement("md-list-item", { type: href ? "link" : onClick ? "button" : "text", href, onClick, disabled, className, "aria-current": selected ? "true" : undefined },
        icon && <Icon name={icon} slot="start" />, <span slot="headline">{headline}</span>, supportingText && <span slot="supporting-text">{supportingText}</span>, trailing && <span slot="end">{trailing}</span>);
}

export function Check({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; disabled?: boolean }) {
    const checkbox = useRef<HTMLElementTagNameMap["md-checkbox"] | null>(null);
    useEffect(() => {
        const element = checkbox.current;
        if (!element) return;
        const change = () => onChange(element.checked);
        element.addEventListener("change", change);
        return () => element.removeEventListener("change", change);
    }, [onChange]);
    return <label className="check-label">{createElement("md-checkbox", { ref: checkbox, checked, disabled, "aria-label": typeof children === "string" ? children : undefined })}<span>{children}</span></label>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
    return createElement("md-circular-progress", { indeterminate: true, "aria-label": label, role: "status" });
}
