import { useRoute } from "vitepress";
import { defineComponent, nextTick, onBeforeUnmount, onMounted, watch } from "vue";

const SCROLLING_CLASS = "is-scrolling";
const SCROLL_IDLE_MS = 600;

function bindSidebarScrollVisibility(sidebar: HTMLElement): () => void {
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;

    const clearScrollTimer = () => {
        if (scrollTimer !== undefined) {
            clearTimeout(scrollTimer);
            scrollTimer = undefined;
        }
    };

    const hideScrollbar = () => {
        sidebar.classList.remove("is-scrolling");
    };

    const handleScroll = () => {
        sidebar.classList.add("is-scrolling");
        clearScrollTimer();
        scrollTimer = setTimeout(hideScrollbar, SCROLL_IDLE_MS);
    };

    sidebar.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
        clearScrollTimer();
        hideScrollbar();
        sidebar.removeEventListener("scroll", handleScroll);
    };
}

export default defineComponent({
    name: "SidebarScrollVisibility",
    setup() {
        const route = useRoute();
        let teardown: (() => void) | undefined;

        const mountSidebarBinding = async () => {
            await nextTick();

            teardown?.();

            const sidebar = document.querySelector<HTMLElement>(".VPSidebar");
            if (!sidebar) {
                teardown = undefined;
                return;
            }

            teardown = bindSidebarScrollVisibility(sidebar);
        };

        onMounted(() => {
            void mountSidebarBinding();
        });

        watch(
            () => route.path,
            () => {
                void mountSidebarBinding();
            },
            { flush: "post" },
        );

        onBeforeUnmount(() => {
            teardown?.();
            teardown = undefined;
        });

        return () => null;
    },
});
