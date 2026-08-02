import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(webRoot, "dist");
const serverDist = resolve(webRoot, "dist-server");
const indexPath = resolve(dist, "index.html");
const serverEntry = pathToFileURL(resolve(serverDist, "entry-server.js")).href;

const [{ renderLanding }, html] = await Promise.all([
  import(serverEntry),
  readFile(indexPath, "utf8"),
]);

const marker = '<div id="app"></div>';
if (!html.includes(marker)) {
  throw new Error(`Could not find the app mount point in ${indexPath}`);
}

const prerendered = html.replace(marker, `<div id="app">${renderLanding()}</div>`);
await writeFile(indexPath, prerendered);
await rm(serverDist, { recursive: true, force: true });

console.log(`Prerendered ${indexPath}`);
