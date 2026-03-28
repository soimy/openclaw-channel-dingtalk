import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("inbound-handler test structure", () => {
  it("does not contain duplicate test titles", () => {
    const filePath = path.resolve(process.cwd(), "tests/unit/inbound-handler.test.ts");
    const source = fs.readFileSync(filePath, "utf8");
    const matches = [...source.matchAll(/\bit\((['"])(.*?)\1/g)];
    const counts = new Map<string, number>();

    for (const match of matches) {
      const title = match[2];
      counts.set(title, (counts.get(title) || 0) + 1);
    }

    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([title, count]) => `${count}x ${title}`);

    expect(duplicates).toEqual([]);
  });
});
