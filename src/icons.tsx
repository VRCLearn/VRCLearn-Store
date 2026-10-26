import { createElement } from "react";
import search from "@material-symbols/svg-500/rounded/search.svg?raw";
import filter from "@material-symbols/svg-500/rounded/filter_list.svg?raw";
import tune from "@material-symbols/svg-500/rounded/tune.svg?raw";
import translate from "@material-symbols/svg-500/rounded/translate.svg?raw";
import palette from "@material-symbols/svg-500/rounded/palette.svg?raw";
import light from "@material-symbols/svg-500/rounded/light_mode.svg?raw";
import dark from "@material-symbols/svg-500/rounded/dark_mode.svg?raw";
import contrast from "@material-symbols/svg-500/rounded/contrast.svg?raw";
import person from "@material-symbols/svg-500/rounded/person.svg?raw";
import accountCircle from "@material-symbols/svg-500/rounded/account_circle.svg?raw";
import favorite from "@material-symbols/svg-500/rounded/favorite.svg?raw";
import storefront from "@material-symbols/svg-500/rounded/storefront.svg?raw";
import arrowForward from "@material-symbols/svg-500/rounded/arrow_forward.svg?raw";
import arrowBack from "@material-symbols/svg-500/rounded/arrow_back.svg?raw";
import arrowOutward from "@material-symbols/svg-500/rounded/arrow_outward.svg?raw";
import close from "@material-symbols/svg-500/rounded/close.svg?raw";
import check from "@material-symbols/svg-500/rounded/check.svg?raw";
import refresh from "@material-symbols/svg-500/rounded/refresh.svg?raw";
import error from "@material-symbols/svg-500/rounded/error.svg?raw";
import info from "@material-symbols/svg-500/rounded/info.svg?raw";
import inventory from "@material-symbols/svg-500/rounded/inventory_2.svg?raw";
import category from "@material-symbols/svg-500/rounded/category.svg?raw";
import add from "@material-symbols/svg-500/rounded/add.svg?raw";
import checkCircle from "@material-symbols/svg-500/rounded/check_circle.svg?raw";
import expandMore from "@material-symbols/svg-500/rounded/arrow_drop_down.svg?raw";
import remove from "@material-symbols/svg-500/rounded/delete.svg?raw";
import edit from "@material-symbols/svg-500/rounded/edit.svg?raw";
import logout from "@material-symbols/svg-500/rounded/logout.svg?raw";
import upload from "@material-symbols/svg-500/rounded/upload.svg?raw";
import email from "@material-symbols/svg-500/rounded/mail.svg?raw";
import security from "@material-symbols/svg-500/rounded/shield.svg?raw";
import clothing from "@material-symbols/svg-500/rounded/checkroom.svg?raw";
import worlds from "@material-symbols/svg-500/rounded/public.svg?raw";
import plugins from "@material-symbols/svg-500/rounded/extension.svg?raw";
import tools from "@material-symbols/svg-500/rounded/build.svg?raw";
import services from "@material-symbols/svg-500/rounded/design_services.svg?raw";
import bookmark from "@material-symbols/svg-500/rounded/bookmark.svg?raw";
import menu from "@material-symbols/svg-500/rounded/menu.svg?raw";
import openInNew from "@material-symbols/svg-500/rounded/open_in_new.svg?raw";
import visibility from "@material-symbols/svg-500/rounded/visibility.svg?raw";
import visibilityOff from "@material-symbols/svg-500/rounded/visibility_off.svg?raw";
import chevronRight from "@material-symbols/svg-500/rounded/chevron_right.svg?raw";
import cloudOff from "@material-symbols/svg-500/rounded/cloud_off.svg?raw";
import searchOff from "@material-symbols/svg-500/rounded/search_off.svg?raw";
import lock from "@material-symbols/svg-500/rounded/lock.svg?raw";
import home from "@material-symbols/svg-500/rounded/home.svg?raw";
import report from "@material-symbols/svg-500/rounded/flag.svg?raw";
import "@material/web/icon/icon.js";

const symbols: Record<string, string> = {
    search, filter, filter_list: filter, tune, settings: tune, translate, language: translate, palette,
    light_mode: light, dark_mode: dark, contrast, person, account: person, account_circle: accountCircle, avatars: person,
    favorite, heart: favorite, storefront, arrow_forward: arrowForward, arrow_back: arrowBack,
    arrow_outward: arrowOutward, close, check, refresh, error, info, inventory, package: inventory,
    category, add, check_circle: checkCircle, verified: checkCircle, expand_more: expandMore,
    delete: remove, edit, logout, upload, email, mail: email, security, shield: security, clothing, worlds, plugins,
    tools, services, bookmark, menu, open_in_new: openInNew, visibility, visibility_off: visibilityOff,
    chevron_right: chevronRight, cloud_off: cloudOff, search_off: searchOff, lock, home, report,
};

/** Only fixed, build-time Material Symbols assets enter this markup. */
export function Icon({ name, size = 24, slot, className }: { name: string; size?: number; slot?: string; className?: string }) {
    const svg = (symbols[name] ?? inventory)
        .replace('<svg ', '<svg fill="currentColor" aria-hidden="true" focusable="false" ')
        .replace('width="48"', 'width="100%"')
        .replace('height="48"', 'height="100%"');
    return createElement("md-icon", { slot, className, "aria-hidden": "true", style: { fontSize: size, width: size, height: size }, dangerouslySetInnerHTML: { __html: svg } });
}
