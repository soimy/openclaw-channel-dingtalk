import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const RELEASE_FILE_PATTERN = /^v(\d+)\.(\d+)\.(\d+)\.md$/;

export type ReleaseSidebarItem = {
    text: string;
    link: string;
};

type ReleaseVersion = {
    major: number;
    minor: number;
    patch: number;
    fileName: string;
};

function parseReleaseVersion(fileName: string): ReleaseVersion | null {
    const match = RELEASE_FILE_PATTERN.exec(fileName);
    if (!match) {
        return null;
    }

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        fileName,
    };
}

function compareReleaseVersionDesc(left: ReleaseVersion, right: ReleaseVersion): number {
    if (left.major !== right.major) {
        return right.major - left.major;
    }

    if (left.minor !== right.minor) {
        return right.minor - left.minor;
    }

    return right.patch - left.patch;
}

export function buildReleaseSidebarItems(fileNames: string[]): ReleaseSidebarItem[] {
    const versions = fileNames
        .map(parseReleaseVersion)
        .filter((version): version is ReleaseVersion => version !== null)
        .sort(compareReleaseVersionDesc);

    return [
        { text: "最新版本", link: "/releases/latest" },
        ...versions.map(({ fileName }) => {
            const version = fileName.slice(0, -".md".length);
            return {
                text: version,
                link: `/releases/${version}`,
            };
        }),
    ];
}

export function getReleaseSidebarItems(): ReleaseSidebarItem[] {
    const releasesDir = resolve(__dirname, "../releases");
    return buildReleaseSidebarItems(readdirSync(releasesDir));
}
