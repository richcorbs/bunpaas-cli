import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { promises as fs } from "fs";
import path from "path";

const TEST_DIR = `/tmp/cli-test-${process.pid}`;
const SRC = path.join(TEST_DIR, "src");
const DIST = path.join(TEST_DIR, "dist");

beforeAll(async () => {
  await fs.mkdir(path.join(SRC, "pages"), { recursive: true });
  await fs.mkdir(path.join(SRC, "layouts"), { recursive: true });
  await fs.mkdir(path.join(SRC, "assets"), { recursive: true });

  // Default layout
  await fs.writeFile(
    path.join(SRC, "layouts", "default.html"),
    "<html><body>{{ content }}</body></html>"
  );

  // Raw layout
  await fs.writeFile(path.join(SRC, "layouts", "raw.html"), "{{ content }}");

  // HTML page
  await fs.writeFile(
    path.join(SRC, "pages", "index.html"),
    "---\nlayout: raw\n---\n<h1>Home</h1>"
  );

  // Markdown page
  await fs.writeFile(
    path.join(SRC, "pages", "about.md"),
    "---\nlayout: default\n---\n# About\n\nThis is **bold** text."
  );

  // site.json (needs at least one non-environments key to be copied)
  await fs.writeFile(path.join(TEST_DIR, "site.json"), JSON.stringify({ platform: true }));
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("Build", () => {
  test("builds site successfully", async () => {
    const proc = Bun.spawn(["bun", path.resolve(import.meta.dir, "../cli.js"), "build"], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
  });

  test("builds HTML page", async () => {
    const content = await fs.readFile(path.join(DIST, "index.html"), "utf8");
    expect(content).toContain("<h1>Home</h1>");
  });

  test("renders markdown to HTML", async () => {
    const content = await fs.readFile(path.join(DIST, "about", "index.html"), "utf8");
    expect(content).toContain("<h1>About</h1>");
    expect(content).toContain("<strong>bold</strong>");
  });

  test("applies layout to markdown", async () => {
    const content = await fs.readFile(path.join(DIST, "about", "index.html"), "utf8");
    expect(content).toContain("<html><body>");
    expect(content).toContain("</body></html>");
  });

  test("copies site.json to dist", async () => {
    const content = await fs.readFile(path.join(DIST, "site.json"), "utf8");
    expect(JSON.parse(content).platform).toBe(true);
  });
});
