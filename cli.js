import path from "path";
import { watch } from "fs";
import { stat, readdir, mkdir as mkdirFs, rm as rmFs, unlink } from "fs/promises";
import matter from "gray-matter";

const PROJECT_DIR = process.cwd();
const SRC = path.join(PROJECT_DIR, "src");
const PAGES = path.join(SRC, "pages");
const LAYOUTS = path.join(SRC, "layouts");
const PARTIALS = path.join(SRC, "partials");
const DIST = path.join(PROJECT_DIR, "dist");
const PORT = parseInt(process.env.PORT || "8000");

/* ---------------------------
   Real-time Channels (SSE)
   --------------------------- */

const sseChannels = new Map();

function sseSubscribe(channel) {
  let ctrl;
  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      if (!sseChannels.has(channel)) {
        sseChannels.set(channel, new Set());
      }
      sseChannels.get(channel).add(controller);
      controller.enqueue("retry: 1000\n\n");
    },
    cancel() {
      const subs = sseChannels.get(channel);
      if (subs) {
        subs.delete(ctrl);
        if (subs.size === 0) sseChannels.delete(channel);
      }
    },
  });

  return {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
    body: stream,
  };
}

function ssePublish(channel, data) {
  const subs = sseChannels.get(channel);
  if (!subs || subs.size === 0) return;

  const payload = typeof data === "object" ? JSON.stringify(data) : String(data);
  const message = `data: ${payload}\n\n`;

  for (const controller of subs) {
    try {
      controller.enqueue(message);
    } catch {
      subs.delete(controller);
    }
  }

  if (subs.size === 0) sseChannels.delete(channel);
}

/* ---------------------------
   _functions Support
   --------------------------- */

async function handleFunction(req, url) {
  const functionsDir = path.join(DIST, "_functions");

  // Check if functions directory exists
  if (!(await dirExists(functionsDir))) {
    return null;
  }

  // Parse query params
  const query = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Parse headers
  const headers = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Find matching function
  const functionFile = await findFunctionFile(functionsDir, url.pathname);
  if (!functionFile) return null;

  // Load function module (with cache busting for dev)
  let functionModule;
  try {
    functionModule = await import(functionFile.path + `?t=${Date.now()}`);
  } catch (err) {
    console.error(`Error loading function ${functionFile.path}:`, err);
    return null;
  }

  // Get handler for method
  const methodName = req.method.toLowerCase();
  const handler =
    functionModule[methodName] ||
    (methodName === "delete" ? functionModule.del : null) ||
    functionModule.default;

  if (!handler || typeof handler !== "function") return null;

  // Parse body based on content type
  let body = null;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  } else if (contentType.includes("application/octet-stream")) {
    body = Buffer.from(await req.arrayBuffer());
  } else if (contentType.includes("text/")) {
    body = await req.text();
  }

  const funcReq = {
    method: req.method,
    path: url.pathname,
    query,
    headers,
    body,
    params: functionFile.params,
    env: process.env,
    subscribe: (channel) => sseSubscribe(channel),
    publish: (channel, data) => ssePublish(channel, data),
  };

  // Execute function
  try {
    const result = await handler(funcReq);
    return buildFunctionResponse(result);
  } catch (err) {
    console.error(`Function error in ${functionFile.path}:`, err);
    return Response.json({ error: "Internal function error" }, { status: 500 });
  }
}

function buildFunctionResponse(result) {
  if (!result) {
    return new Response(null, { status: 204 });
  }

  const status = result.status || 200;
  const resHeaders = new Headers(result.headers || {});
  const body = result.body;

  if (body === undefined || body === null) {
    return new Response(null, { status, headers: resHeaders });
  }

  if (body instanceof ReadableStream) {
    return new Response(body, { status, headers: resHeaders });
  }

  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return new Response(body, { status, headers: resHeaders });
  }

  if (typeof body === "object") {
    resHeaders.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status, headers: resHeaders });
  }

  return new Response(String(body), { status, headers: resHeaders });
}

async function findFunctionFile(functionsDir, reqPath) {
  const segments = reqPath.replace(/^\//, "").split("/").filter(Boolean);
  if (segments.length === 0) segments.push("index");

  // Try direct match
  const directPath = path.join(functionsDir, ...segments) + ".js";
  if (await fileExists(directPath)) {
    return { path: directPath, params: {} };
  }

  // Try index
  const indexPath = path.join(functionsDir, ...segments, "index.js");
  if (await fileExists(indexPath)) {
    return { path: indexPath, params: {} };
  }

  // Try dynamic routes
  return findDynamicRoute(functionsDir, segments, {});
}

async function findDynamicRoute(baseDir, segments, params) {
  if (segments.length === 0) return null;

  const [current, ...rest] = segments;

  // Try exact directory
  const exactDir = path.join(baseDir, current);
  if (await dirExists(exactDir)) {
    if (rest.length === 0) {
      const indexPath = path.join(exactDir, "index.js");
      if (await fileExists(indexPath)) {
        return { path: indexPath, params };
      }
    } else {
      const directFile = path.join(exactDir, ...rest) + ".js";
      if (await fileExists(directFile)) {
        return { path: directFile, params };
      }
      const result = await findDynamicRoute(exactDir, rest, params);
      if (result) return result;
    }
  }

  // Try dynamic routes
  try {
    const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: baseDir, onlyFiles: false }));

    for (const name of entries) {
      const fullPath = path.join(baseDir, name);
      const isDir = await dirExists(fullPath);

      const dirMatch = name.match(/^\[(\w+)\]$/);
      if (dirMatch && isDir) {
        const paramName = dirMatch[1];
        const newParams = { ...params, [paramName]: current };
        const dynamicDir = fullPath;

        if (rest.length === 0) {
          const indexPath = path.join(dynamicDir, "index.js");
          if (await fileExists(indexPath)) {
            return { path: indexPath, params: newParams };
          }
        } else {
          const directFile = path.join(dynamicDir, ...rest) + ".js";
          if (await fileExists(directFile)) {
            return { path: directFile, params: newParams };
          }
          const result = await findDynamicRoute(dynamicDir, rest, newParams);
          if (result) return result;
        }
      }

      const fileMatch = name.match(/^\[(\w+)\]\.js$/);
      if (fileMatch && !isDir && rest.length === 0) {
        return {
          path: fullPath,
          params: { ...params, [fileMatch[1]]: current },
        };
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return null;
}

async function fileExists(filePath) {
  return Bun.file(filePath).exists();
}

async function dirExists(dirPath) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/* ---------------------------
   CLI
   --------------------------- */
const args = process.argv.slice(2);
const command = args[0];

const commands = {
  build: () => build(),
  dev: () => dev(),
  deploy: () => deploy(args[1]),
  init: () => initProject(),
};

function showHelp() {
  console.log("Usage: bunpaas-cli <build|dev|deploy|init>");
  console.log("\nCommands:");
  console.log("  build              Build the site");
  console.log("  dev                Start dev server with live reload");
  console.log("  deploy [env]       Deploy to PaaS (production/staging/development)");
  console.log("  init               Initialize project with site.json and .bunpaas");
  process.exit(1);
}

const run = commands[command];
if (!run) showHelp();

run()
  .then(() => command !== "dev" && process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

/* ---------------------------
   Utility: File operations
   --------------------------- */
async function readFile(filePath) {
  return Bun.file(filePath).text();
}

async function writeFile(filePath, content) {
  await Bun.write(filePath, content);
}

async function fileExists(filePath) {
  return Bun.file(filePath).exists();
}

async function dirExists(dirPath) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function copyFile(src, dest) {
  const content = await Bun.file(src).arrayBuffer();
  await Bun.write(dest, content);
}

async function mkdir(dir) {
  await mkdirFs(dir, { recursive: true });
}

async function rm(dir) {
  await rmFs(dir, { recursive: true, force: true });
}

async function copyRecursive(src, dest) {
  const s = await stat(src);
  if (s.isDirectory()) {
    await mkdir(dest);
    const entries = await readdir(src);
    await Promise.all(entries.map((entry) => copyRecursive(path.join(src, entry), path.join(dest, entry))));
  } else {
    await mkdir(path.dirname(dest));
    await copyFile(src, dest);
  }
}

async function readFilesRecursive(dir, baseDir = dir) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await readFilesRecursive(fullPath, baseDir);
        results.push(...subFiles);
      } else {
        results.push({
          path: fullPath,
          relativePath: path.relative(baseDir, fullPath),
        });
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return results;
}

/* ---------------------------
   Templates (layouts & partials)
   --------------------------- */
let templateCache = Object.create(null);

const CONTENT_REGEX = /\{\{\s*content\s*\}\}/gi;
const PARTIAL_REGEX = /\{\{\s*([a-zA-Z0-9_\/-]+)\s*\}\}/g;

async function loadTemplateDir(dir, prefix = "") {
  const files = await readFilesRecursive(dir);
  await Promise.all(
    files.map(async (file) => {
      if (!file.path.endsWith(".html")) return;
      const content = await readFile(file.path);
      const key = prefix + file.relativePath.replace(/\.html$/, "").replace(/\\/g, "/");
      templateCache[key] = content;
    }),
  );
}

async function loadTemplates() {
  templateCache = Object.create(null);
  await Promise.all([
    loadTemplateDir(LAYOUTS, "layouts/"),
    loadTemplateDir(PARTIALS),
  ]);
}

function applyTemplates(html, data) {
  return html.replace(PARTIAL_REGEX, (match, name) => {
    if (templateCache[name]) return templateCache[name];
    if (data[name] !== undefined) return data[name];
    return match;
  });
}

async function renderPage(rawContent, frontmatter, isMarkdown = true, injectLiveReload = false) {
  const htmlBody = isMarkdown ? Bun.markdown.html(rawContent) : rawContent;
  const layoutName = frontmatter.layout || "default";
  const layoutHtml = templateCache[`layouts/${layoutName}`];

  if (!layoutHtml) {
    throw new Error(`Layout "${layoutName}" not found. Create src/layouts/${layoutName}.html`);
  }

  let merged = layoutHtml.replace(CONTENT_REGEX, htmlBody);
  merged = applyTemplates(merged, frontmatter);

  if (injectLiveReload) {
    merged = injectReloadScript(merged);
  }

  return merged;
}

function outputPathForPage(filename) {
  return filename.replace(/\.md$/, ".html");
}

/* ---------------------------
   Live reload (SSE)
   --------------------------- */
let reloadClients = [];

function injectReloadScript(html) {
  const script = `<script>
    (function(){
      const es = new EventSource('/livereload');
      es.addEventListener('reload', function(){ location.reload(); });
    })();
  </script></body>`;
  return html.replace(/<\/body>/i, script);
}

function triggerReload() {
  console.log(`⟳ Reloading ${reloadClients.length} client(s)...`);
  reloadClients.forEach((controller) => {
    try {
      controller.enqueue(`event: reload\ndata: ${Date.now()}\n\n`);
    } catch (err) {
      // Controller closed, will be cleaned up on next connection
    }
  });
  // Clean up closed controllers
  reloadClients = reloadClients.filter((c) => {
    try {
      c.desiredSize; // Check if controller is still valid
      return true;
    } catch {
      return false;
    }
  });
}

/* ---------------------------
   Build tasks
   --------------------------- */
async function cleanDist() {
  await rm(DIST);
}

async function buildPagesTask(injectLiveReload = false) {
  const files = await readFilesRecursive(PAGES);
  const pageFiles = files.filter((f) => f.path.endsWith(".md") || f.path.endsWith(".html"));

  await Promise.all(pageFiles.map(async (file) => {
    try {
      const raw = await readFile(file.path);
      const isMarkdown = file.path.endsWith(".md");
      const { data: frontmatter, content } = matter(raw);
      const rendered = await renderPage(content, frontmatter, isMarkdown, injectLiveReload);

      const out = file.relativePath.endsWith(".html")
        ? file.relativePath
        : outputPathForPage(file.relativePath);
      await mkdir(path.dirname(path.join(DIST, out)));
      await writeFile(path.join(DIST, out), rendered);

      console.log(`✓ Built ${out}`);
    } catch (err) {
      console.error(`\n❌ Error building ${file.relativePath}:`);
      console.error(`   ${err.message}`);
      throw err;
    }
  }));
}

async function copyAssetsTask() {
  const src = path.join(SRC, "assets");
  if (await dirExists(src)) {
    await copyRecursive(src, path.join(DIST, "assets"));
    console.log("✓ Copied assets");
  }
}

async function copyFunctionsTask() {
  const src = path.join(SRC, "_functions");
  if (await dirExists(src)) {
    await copyRecursive(src, path.join(DIST, "_functions"));
    console.log("✓ Copied _functions");
  }
}

async function copySiteConfigTask() {
  const siteJsonPath = path.join(PROJECT_DIR, "site.json");
  if (await fileExists(siteJsonPath)) {
    const content = await readFile(siteJsonPath);
    const config = JSON.parse(content);
    delete config.environments;
    if (Object.keys(config).length > 0) {
      await writeFile(path.join(DIST, "site.json"), JSON.stringify(config, null, 2) + "\n");
      console.log("✓ Copied site.json");
    }
  }
}

async function copyPackageJsonTask() {
  const packageJsonPath = path.join(PROJECT_DIR, "package.json");
  if (await fileExists(packageJsonPath)) {
    const content = await readFile(packageJsonPath);
    const pkg = JSON.parse(content);
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      const deployPkg = {
        name: pkg.name,
        version: pkg.version,
        type: pkg.type,
        dependencies: pkg.dependencies,
      };
      await writeFile(path.join(DIST, "package.json"), JSON.stringify(deployPkg, null, 2) + "\n");
      console.log("✓ Copied package.json");
    }
  }
}

async function copyRedirectsTask() {
  const redirectsPath = path.join(PROJECT_DIR, "_redirects");
  if (await fileExists(redirectsPath)) {
    await copyFile(redirectsPath, path.join(DIST, "_redirects"));
    console.log("✓ Copied _redirects");
  }
}

async function copyErrorPagesTask() {
  const errorPages = ["404.html", "500.html", "503.html"];
  for (const page of errorPages) {
    const pagePath = path.join(PAGES, page);
    if (await fileExists(pagePath)) {
      await copyFile(pagePath, path.join(DIST, page));
      console.log(`✓ Copied ${page}`);
    }
  }
}

async function build(injectLiveReload = false) {
  const startTime = performance.now();
  console.log("Building...");

  await cleanDist();
  await loadTemplates();
  await Promise.all([
    buildPagesTask(injectLiveReload),
    copyAssetsTask(),
    copyFunctionsTask(),
    copySiteConfigTask(),
    copyPackageJsonTask(),
    copyRedirectsTask(),
    copyErrorPagesTask(),
  ]);

  const duration = (performance.now() - startTime).toFixed(2);
  console.log(`✓ Build complete (${duration}ms)`);
}

/* ---------------------------
   Dev mode with Bun.serve()
   --------------------------- */
let rebuildTimer = null;
const DEBOUNCE_MS = 120;

function scheduleDebouncedRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    console.log("\nRebuilding...");
    try {
      await build(true);
      triggerReload();
    } catch (err) {
      console.error("Build error:", err.message);
    }
  }, DEBOUNCE_MS);
}

async function dev() {
  await build(true).catch((err) => console.error("Initial build failed:", err));

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // Live reload SSE endpoint
      if (url.pathname === "/livereload") {
        const stream = new ReadableStream({
          start(controller) {
            reloadClients.push(controller);
            controller.enqueue("retry: 1000\n\n");
          },
          cancel(controller) {
            reloadClients = reloadClients.filter((c) => c !== controller);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // Try static files first
      let filePath = path.join(DIST, url.pathname);

      // Try exact path
      let file = Bun.file(filePath);
      if (await file.exists()) {
        const stat = await file.stat();
        if (stat.isDirectory()) {
          file = Bun.file(path.join(filePath, "index.html"));
        }
        if (await file.exists()) {
          return new Response(file);
        }
      }

      // Try with .html extension
      file = Bun.file(filePath + ".html");
      if (await file.exists()) {
        return new Response(file);
      }

      // Try index.html in directory
      file = Bun.file(path.join(filePath, "index.html"));
      if (await file.exists()) {
        return new Response(file);
      }

      // Try function handlers as fallback
      const functionResponse = await handleFunction(req, url);
      if (functionResponse) return functionResponse;

      return new Response("Not Found", { status: 404 });
    },
  });

  // Watch src directory
  watch(SRC, { recursive: true }, (event, filename) => {
    if (filename && /^\.|\.(DS_Store|swp|tmp|lock)$|~$|#.*#$/.test(filename)) return;
    scheduleDebouncedRebuild();
  });

  console.log(`\nDev server: http://localhost:${server.port}`);
  console.log("Watching src/ for changes...\n");
}

/* ---------------------------
   Deploy to PaaS
   --------------------------- */
async function exec(cmd, args) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${cmd} exited with code ${exitCode}`);
  }
}

async function prompt(question) {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

async function readJsonFile(filePath) {
  if (!(await fileExists(filePath))) return null;
  try {
    const content = await readFile(filePath);
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, data) {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
}

async function waitForServer(endpoint, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${endpoint}/health`, { timeout: 2000 });
      if (res.ok) return;
    } catch {
      // Server not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server not responding after multiple attempts");
}

async function uploadTarball(endpoint, host, deployKey, tarballPath) {
  const tarballData = await Bun.file(tarballPath).arrayBuffer();

  const res = await fetch(`${endpoint}/deploy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Deploy-Key": deployKey,
      "X-Target-Host": host,
    },
    body: tarballData,
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Server returned invalid JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

async function deploy(envArg) {
  const startTime = performance.now();
  const siteJsonPath = path.join(PROJECT_DIR, "site.json");
  const bunpaasPath = path.join(PROJECT_DIR, ".bunpaas");

  let siteConfig = await readJsonFile(siteJsonPath);
  if (!siteConfig) {
    console.log("No site.json found. Run 'bun cli.js init' to create one.");
    process.exit(1);
  }

  let bunpaas = await readJsonFile(bunpaasPath) || {};

  const environments = siteConfig.environments || {};
  const envNames = Object.keys(environments);

  if (envNames.length === 0) {
    console.log("No environments defined in site.json.");
    console.log("Add an 'environments' section like:");
    console.log('  "environments": { "production": "www.example.com" }');
    process.exit(1);
  }

  let env = envArg;
  if (!env) {
    if (envNames.length === 1) {
      env = envNames[0];
    } else {
      console.log("Available environments:");
      envNames.forEach((e, i) => console.log(`  ${i + 1}. ${e} → ${environments[e]}`));
      const choice = await prompt(`\nSelect environment (1-${envNames.length}): `);
      const idx = parseInt(choice, 10) - 1;
      if (idx < 0 || idx >= envNames.length) {
        console.log("Invalid selection.");
        process.exit(1);
      }
      env = envNames[idx];
    }
  }

  const targetHost = environments[env];
  if (!targetHost) {
    console.log(`Environment "${env}" not found in site.json.`);
    console.log(`Available: ${envNames.join(", ")}`);
    process.exit(1);
  }

  const deployKeys = bunpaas.deployKeys || {};
  let deployKey = deployKeys[env] || bunpaas.deployKey;
  if (!deployKey) {
    deployKey = await prompt(`Enter deploy key for ${env}: `);
    if (!bunpaas.deployKeys) bunpaas.deployKeys = {};
    bunpaas.deployKeys[env] = deployKey;
    await writeJsonFile(bunpaasPath, bunpaas);
    console.log("Saved deploy key to .bunpaas\n");
  }

  const platformEndpoints = bunpaas.platformEndpoints || {};
  let endpoint = platformEndpoints[env] || platformEndpoints.production;
  if (!endpoint) {
    endpoint = await prompt("Enter platform endpoint (e.g., https://bunpaas-admin.example.com): ");
    if (!bunpaas.platformEndpoints) bunpaas.platformEndpoints = {};
    bunpaas.platformEndpoints[env] = endpoint;
    await writeJsonFile(bunpaasPath, bunpaas);
    console.log("Saved platform endpoint to .bunpaas\n");
  }

  console.log(`\nDeploying to ${targetHost} (${env})...\n`);

  console.log("→ Building...");
  await build();

  console.log("→ Creating tarball...");
  const timestamp = Date.now();
  const tarball = `deploy-${timestamp}.tar.gz`;
  const tarballPath = path.join(PROJECT_DIR, tarball);
  await exec("tar", ["-czf", tarball, "-C", "dist", "."]);

  console.log("→ Waiting for server...");
  await waitForServer(endpoint);

  console.log(`→ Uploading to ${endpoint}...`);
  try {
    const result = await uploadTarball(endpoint, targetHost, deployKey, tarballPath);
    console.log(`→ Server response: deploy ${result.deploy}`);
  } finally {
    await unlink(tarballPath).catch(() => {});
  }

  const duration = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`\n✓ Deployed ${targetHost} successfully in ${duration}s\n`);
}

/* ---------------------------
   Init Project
   --------------------------- */
const TEMPLATE_URL = "https://github.com/richcorbs/bunpaas-cli/archive/main.tar.gz";
const TEMPLATE_PREFIX = "bunpaas-cli-main/template/";

async function downloadTemplate() {
  console.log("→ Downloading template...");
  const proc = Bun.spawn(
    ["sh", "-c", `curl -sL "${TEMPLATE_URL}" | tar -xz --strip-components=2 "${TEMPLATE_PREFIX}"`],
    { stdout: "inherit", stderr: "inherit", cwd: PROJECT_DIR },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to download template. Check your internet connection.");
  }
}

async function initProject() {
  const siteJsonPath = path.join(PROJECT_DIR, "site.json");
  const bunpaasPath = path.join(PROJECT_DIR, ".bunpaas");

  if (await dirExists(path.join(PROJECT_DIR, "src"))) {
    console.log("Project already has a src/ directory. Skipping template download.");
  } else {
    await downloadTemplate();
    console.log("✓ Template downloaded\n");
  }

  const siteExists = await readJsonFile(siteJsonPath);
  if (!siteExists) {
    const domain = await prompt("Production domain (e.g., www.example.com): ");
    const siteConfig = {
      environments: {
        production: domain,
      },
    };
    await writeJsonFile(siteJsonPath, siteConfig);
    console.log("Created site.json");
  }

  const bunpaasExists = await readJsonFile(bunpaasPath);
  if (!bunpaasExists) {
    const deployKey = await prompt("Deploy key (leave blank to set later): ");
    const platformEndpoint = await prompt("Platform endpoint (e.g., https://bunpaas-admin.example.com): ");

    const bunpaas = {
      deployKeys: {
        production: deployKey || "",
        development: deployKey || "",
      },
      platformEndpoints: {
        production: platformEndpoint || "",
        development: "http://bunpaas-admin.localhost:7001",
      },
    };
    await writeJsonFile(bunpaasPath, bunpaas);
    console.log("Created .bunpaas");
  }

  console.log("\n✓ Project initialized!");
  console.log("\nNext steps:");
  console.log("  1. Set your deploy keys in .bunpaas (get them from the admin UI)");
  console.log("  2. Run: bunpaas-cli dev");
}
