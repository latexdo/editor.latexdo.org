import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const indexHtml = path.join(dist, "index.html");
const assets = path.join(dist, "assets");

await stat(indexHtml);
const assetFiles = await readdir(assets);

if (assetFiles.length === 0) {
  throw new Error("dist/assets is empty; run npm run build:frontend first.");
}

console.log(`Preview build ready: dist/index.html plus ${assetFiles.length} asset files.`);
