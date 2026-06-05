import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

export type WebridgePackageResult = {
  extensionDir: string;
  version: string;
  zipPath: string;
  manifestPath: string;
  sha256: string;
};

export function defaultWebridgeExtensionDir(projectRoot = process.cwd()): string {
  const candidates = [
    process.env.FORGE_WEBRIDGE_EXTENSION_DIR,
    join(resolve(projectRoot), "plugins", "forgewebridge", "chrome-extension"),
    "/Users/leileqi/plugins/forgewebridge/chrome-extension",
  ].filter((item): item is string => typeof item === "string" && item.length > 0);
  const found = candidates.find((candidate) => existsSync(join(candidate, "manifest.json")));
  return found ?? candidates[candidates.length - 1]!;
}

export function readWebridgeManifest(extensionDir: string): { name: string; version: string } {
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    name?: unknown;
    version?: unknown;
  };
  return {
    name: typeof manifest.name === "string" ? manifest.name : "ForgeWebridge",
    version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
  };
}

export function ensureWebridgeIcons(extensionDir: string): string[] {
  const iconDir = join(extensionDir, "icons");
  mkdirSync(iconDir, { recursive: true });
  const paths: string[] = [];
  for (const size of [16, 32, 48, 128]) {
    const iconPath = join(iconDir, `icon${size}.png`);
    writeFileSync(iconPath, renderForgePng(size));
    paths.push(iconPath);
  }
  return paths;
}

export function ensureWebridgeManifestCompatibility(extensionDir: string): string {
  const manifestPath = join(extensionDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`ForgeWebridge extension manifest not found: ${extensionDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  const permissions = uniqueStringArray(manifest.permissions);
  const hostPermissions = uniqueStringArray(manifest.host_permissions);
  let changed = false;
  if (!permissions.includes("activeTab")) {
    permissions.push("activeTab");
    changed = true;
  }
  if (!hostPermissions.includes("<all_urls>")) {
    hostPermissions.push("<all_urls>");
    changed = true;
  }
  if (changed) {
    manifest.permissions = permissions;
    manifest.host_permissions = hostPermissions;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    try {
      chmodSync(manifestPath, 0o644);
    } catch {
      // Some filesystems ignore POSIX modes.
    }
  }
  return manifestPath;
}

export function packageWebridgeExtension(options?: {
  extensionDir?: string;
  outputDir?: string;
}): WebridgePackageResult {
  const extensionDir = resolve(options?.extensionDir ?? defaultWebridgeExtensionDir());
  if (!existsSync(join(extensionDir, "manifest.json"))) {
    throw new Error(`ForgeWebridge extension manifest not found: ${extensionDir}`);
  }
  ensureWebridgeManifestCompatibility(extensionDir);
  ensureWebridgeIcons(extensionDir);

  const manifest = readWebridgeManifest(extensionDir);
  const outputDir = resolve(options?.outputDir ?? join(process.cwd(), ".forge", "release"));
  mkdirSync(outputDir, { recursive: true });
  const zipPath = join(outputDir, `${manifest.name}-${manifest.version}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync("zip", [
    "-qr",
    zipPath,
    ".",
    "-x",
    "*.DS_Store",
    "__MACOSX/*",
  ], {
    cwd: extensionDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  const releaseManifest = {
    name: manifest.name,
    version: manifest.version,
    extensionDir,
    zipPath,
    sha256,
    generatedAt: new Date().toISOString(),
  };
  const manifestPath = join(outputDir, `${manifest.name}-${manifest.version}.json`);
  writeFileSync(manifestPath, JSON.stringify(releaseManifest, null, 2), "utf-8");
  return {
    extensionDir,
    version: manifest.version,
    zipPath,
    manifestPath,
    sha256,
  };
}

function uniqueStringArray(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return Array.from(new Set(items));
}

function renderForgePng(size: number): Buffer {
  const width = size;
  const height = size;
  const pixels = Buffer.alloc(width * height * 4);
  const scale = size / 128;
  const bg = [34, 40, 49, 255] as const;
  const accent = [55, 151, 91, 255] as const;
  const white = [246, 248, 250, 255] as const;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      setPixel(pixels, width, x, y, bg);
    }
  }

  drawRect(pixels, width, height, Math.round(10 * scale), Math.round(10 * scale), Math.round(108 * scale), Math.round(108 * scale), accent);
  drawRect(pixels, width, height, Math.round(25 * scale), Math.round(25 * scale), Math.round(18 * scale), Math.round(78 * scale), white);
  drawRect(pixels, width, height, Math.round(25 * scale), Math.round(25 * scale), Math.round(66 * scale), Math.round(17 * scale), white);
  drawRect(pixels, width, height, Math.round(25 * scale), Math.round(56 * scale), Math.round(52 * scale), Math.round(15 * scale), white);
  drawRect(pixels, width, height, Math.round(77 * scale), Math.round(83 * scale), Math.round(26 * scale), Math.round(18 * scale), white);

  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]));
    rows.push(pixels.subarray(y * width * 4, (y + 1) * width * 4));
  }

  return png([
    chunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawRect(
  pixels: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly [number, number, number, number],
): void {
  for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
      setPixel(pixels, width, xx, yy, color);
    }
  }
}

function setPixel(
  pixels: Buffer,
  width: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const index = (y * width + x) * 4;
  pixels[index] = color[0];
  pixels[index + 1] = color[1];
  pixels[index + 2] = color[2];
  pixels[index + 3] = color[3];
}

function png(chunks: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuf,
    data,
    uint32(crc32(Buffer.concat([typeBuf, data]))),
  ]);
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
