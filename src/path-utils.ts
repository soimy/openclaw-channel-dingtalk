import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_ROOT_DIRECTORIES = new Set([
  "Users",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
  "Windows",
  "Documents and Settings",
]);

export function resolveRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  const segments = (value: string): string[] => value.split(/[\\/]+/).filter(Boolean);
  const pathSegments = segments(trimmed);
  const firstSegment = pathSegments[0];

  if (trimmed === "~") {
    return path.resolve(os.homedir());
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), ...segments(trimmed.slice(2)));
  }

  if (process.platform === "win32") {
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      return path.win32.normalize(trimmed);
    }
    if (firstSegment && /^[a-zA-Z]:$/.test(firstSegment)) {
      return path.win32.resolve(`${firstSegment}\\`, ...pathSegments.slice(1));
    }
    if (firstSegment && WINDOWS_ROOT_DIRECTORIES.has(firstSegment)) {
      return path.win32.resolve("\\", ...pathSegments);
    }
  }

  if (/^[\\/]/.test(trimmed)) {
    return path.resolve(path.sep, ...pathSegments);
  }

  return path.resolve(process.cwd(), ...pathSegments);
}

export const resolveUserPath = resolveRelativePath;
