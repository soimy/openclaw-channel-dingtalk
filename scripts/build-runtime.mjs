import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
    bundle: true,
    entryPoints: ["index.ts"],
    external: ["openclaw", "openclaw/*", "@openclaw/*"],
    format: "esm",
    logLevel: "info",
    outfile: "dist/index.js",
    packages: "external",
    platform: "node",
    sourcemap: true,
    target: "node22",
    tsconfigRaw: {
        compilerOptions: {
            esModuleInterop: true,
            module: "ESNext",
            moduleResolution: "bundler",
            target: "ES2023",
        },
    },
});
