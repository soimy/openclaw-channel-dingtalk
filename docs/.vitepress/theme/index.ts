import DefaultTheme from "vitepress/theme";
import { Fragment, h } from "vue";
import SidebarScrollVisibility from "./sidebar-scroll-visibility";
import "./custom.css";

export default {
    extends: DefaultTheme,
    Layout() {
        return h(Fragment, [h(DefaultTheme.Layout), h(SidebarScrollVisibility)]);
    },
};
