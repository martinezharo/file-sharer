import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(webRoot, "public/og.svg");
const output = resolve(webRoot, "public/og.png");

await mkdir(dirname(output), { recursive: true });
await sharp(input).png({ compressionLevel: 9 }).toFile(output);

console.log(`Generated ${output}`);
