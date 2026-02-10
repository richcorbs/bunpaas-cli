import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "bun";

const TEST_DIR = `/tmp/cli-dev-test-${process.pid}`;
const SRC = path.join(TEST_DIR, "src");
const PORT = 8099;
let devProc;

async function request(urlPath, options = {}) {
  const { method = "GET", headers = {}, body } = options;
  return fetch(`http://localhost:${PORT}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  // Create project structure
  await fs.mkdir(path.join(SRC, "pages"), { recursive: true });
  await fs.mkdir(path.join(SRC, "layouts"), { recursive: true });
  await fs.mkdir(path.join(SRC, "_functions"), { recursive: true });

  // Layout
  await fs.writeFile(path.join(SRC, "layouts", "raw.html"), "{{ content }}");

  // Static page
  await fs.writeFile(
    path.join(SRC, "pages", "index.html"),
    "---\nlayout: raw\n---\n<h1>Home</h1>"
  );

  // site.json
  await fs.writeFile(path.join(TEST_DIR, "site.json"), JSON.stringify({ platform: true }));

  // Function: GET /hello
  await fs.writeFile(
    path.join(SRC, "_functions", "hello.js"),
    `export function get(req) {
  return { body: { message: "Hello", query: req.query } };
}
export function post(req) {
  return { body: { received: req.body } };
}`
  );

  // Function: GET /subscribe — SSE channel subscribe
  await fs.writeFile(
    path.join(SRC, "_functions", "subscribe.js"),
    `export function get(req) {
  return req.subscribe(req.query.channel || "default");
}`
  );

  // Function: POST /publish — publish to channel
  await fs.writeFile(
    path.join(SRC, "_functions", "publish.js"),
    `export function post(req) {
  req.publish(req.body.channel, req.body.message);
  return { body: { sent: true } };
}`
  );

  // Start dev server
  const cliPath = path.resolve(import.meta.dir, "../cli.js");
  devProc = spawn({
    cmd: ["bun", cliPath, "dev"],
    cwd: TEST_DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for server
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) break;
    } catch {}
    await Bun.sleep(100);
  }
});

afterAll(async () => {
  devProc?.kill();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("Dev Server - Static", () => {
  test("serves static page", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Home</h1>");
  });

  test("returns 404 for missing path", async () => {
    const res = await request("/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("Dev Server - Functions", () => {
  test("handles GET function", async () => {
    const res = await request("/hello");
    const body = await res.json();
    expect(body.message).toBe("Hello");
  });

  test("passes query params", async () => {
    const res = await request("/hello?name=test");
    const body = await res.json();
    expect(body.query.name).toBe("test");
  });

  test("handles POST with JSON body", async () => {
    const res = await request("/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { name: "test" },
    });
    const body = await res.json();
    expect(body.received.name).toBe("test");
  });
});

describe("Dev Server - Channels", () => {
  test("subscribe returns SSE headers", async () => {
    const res = await request("/subscribe?channel=test-headers");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("publish delivers message to subscriber", async () => {
    const subRes = await request("/subscribe?channel=test-pub");
    const reader = subRes.body.getReader();
    const decoder = new TextDecoder();

    // Read the initial retry message
    const { value: initial } = await reader.read();
    expect(decoder.decode(initial)).toContain("retry:");

    // Publish a message
    await request("/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { channel: "test-pub", message: { greeting: "hello" } },
    });

    // Read the published message
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain("data:");
    expect(text).toContain("hello");

    reader.cancel();
  });
});
