const TASK_MARKER_RE = /^\[([ xX])\]\s+/;

function appendClass(token: { attrGet(name: string): string | null; attrSet(name: string, value: string): void }, className: string): void {
    const current = token.attrGet("class");
    const classNames = current ? current.split(/\s+/).filter(Boolean) : [];

    if (!classNames.includes(className)) {
        classNames.push(className);
        token.attrSet("class", classNames.join(" "));
    }
}

export function applyTaskListPlugin(md: any): void {
    md.core.ruler.after("inline", "openclaw-task-list", (state: any) => {
        for (let index = 0; index < state.tokens.length; index += 1) {
            const token = state.tokens[index];
            if (token.type !== "inline" || !Array.isArray(token.children) || token.children.length === 0) {
                continue;
            }

            const firstTextIndex = token.children.findIndex((child: any) => child.type === "text" && typeof child.content === "string" && child.content.length > 0);
            if (firstTextIndex === -1) {
                continue;
            }

            const firstTextToken = token.children[firstTextIndex];
            const markerMatch = firstTextToken.content.match(TASK_MARKER_RE);
            if (!markerMatch) {
                continue;
            }

            const checked = markerMatch[1].toLowerCase() === "x";
            firstTextToken.content = firstTextToken.content.slice(markerMatch[0].length);

            const checkboxToken = new state.Token("html_inline", "", 0);
            checkboxToken.content = `<input class="task-list-item-checkbox" type="checkbox" disabled="disabled"${checked ? ' checked="checked"' : ""}> `;
            token.children.unshift(checkboxToken);

            for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
                const current = state.tokens[cursor];

                if (current.type === "list_item_open") {
                    appendClass(current, "task-list-item");
                    break;
                }

                if (current.type === "bullet_list_open" || current.type === "ordered_list_open") {
                    break;
                }
            }

            for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
                const current = state.tokens[cursor];

                if (current.type === "bullet_list_open" || current.type === "ordered_list_open") {
                    appendClass(current, "contains-task-list");
                    break;
                }
            }
        }
    });
}
