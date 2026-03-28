import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

function ensureParentDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function createShellProcessRunner() {
    return {
        async run(command, outputPath) {
            ensureParentDir(outputPath);
            const result = spawnSync(command, {
                cwd: process.cwd(),
                encoding: "utf8",
                shell: true,
            });
            fs.writeFileSync(outputPath, `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");

            if (result.status !== 0) {
                throw new Error(`Command failed (${result.status}): ${command}`);
            }

            return { exitCode: result.status ?? 0 };
        },
        async start(command, outputPath) {
            ensureParentDir(outputPath);
            const output = fs.openSync(outputPath, "a");
            const child = spawn(command, {
                cwd: process.cwd(),
                detached: true,
                shell: true,
                stdio: ["ignore", output, output],
            });
            child.unref();
            return { pid: child.pid ?? 0 };
        },
    };
}
