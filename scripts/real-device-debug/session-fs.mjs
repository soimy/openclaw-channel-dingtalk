import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJsonFile(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeTextFile(filePath, value) {
    fs.writeFileSync(filePath, value, "utf8");
}

export function resolveSessionFilePaths(rootDir) {
    return {
        sessionDir: rootDir,
        manifestPath: path.join(rootDir, "manifest.json"),
        timelinePath: path.join(rootDir, "timeline.json"),
        operatorStepsPath: path.join(rootDir, "operator-steps.md"),
    };
}
