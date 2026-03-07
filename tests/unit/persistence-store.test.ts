import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    readNamespaceJson,
    resolveNamespacePath,
    writeNamespaceJsonAtomic,
} from "../../src/persistence-store";

describe("persistence-store", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createStorePath(): string {
        const dir = path.join(
            os.tmpdir(),
            `openclaw-dingtalk-persist-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        );
        tempDirs.push(dir);
        return path.join(dir, "session-store.json");
    }

    it("builds account-scoped namespace path under dirname(storePath)", () => {
        const storePath = createStorePath();
        const resolved = resolveNamespacePath("cards.active.pending", {
            storePath,
            scope: { accountId: "main" },
            format: "json",
        });

        expect(resolved).toContain(path.join(path.dirname(storePath), "dingtalk-state"));
        expect(resolved).toContain("cards.active.pending");
        expect(resolved).toContain("account-bWFpbg");
        expect(resolved.endsWith(".json")).toBe(true);
    });

    it("writes and reads namespaced JSON atomically", () => {
        const storePath = createStorePath();
        const payload = {
            version: 1,
            updatedAt: Date.now(),
            pendingCards: [{ accountId: "main", cardInstanceId: "card_1" }],
        };

        writeNamespaceJsonAtomic("cards.active.pending", {
            storePath,
            scope: { accountId: "main" },
            data: payload,
        });

        const actual = readNamespaceJson<typeof payload>("cards.active.pending", {
            storePath,
            scope: { accountId: "main" },
            fallback: { version: 0, updatedAt: 0, pendingCards: [] },
        });

        expect(actual).toEqual(payload);
    });

    it("returns fallback when JSON is malformed", () => {
        const storePath = createStorePath();
        const filePath = resolveNamespacePath("members.group-roster", {
            storePath,
            scope: { groupId: "cid123" },
            format: "json",
        });
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "not-json");

        const fallback = { users: {} as Record<string, string> };
        const actual = readNamespaceJson("members.group-roster", {
            storePath,
            scope: { groupId: "cid123" },
            fallback,
        });

        expect(actual).toEqual(fallback);
    });
});
