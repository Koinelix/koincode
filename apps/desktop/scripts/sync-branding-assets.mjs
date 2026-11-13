import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const manifestPath = "brand/koincode-assets.json";
const sources = ["brand/koincode-icon.svg", "brand/koincode-logo.svg", "brand/koincode-dmg.svg"];
const desktop = "apps/desktop/packages/desktop";
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const copies = [
  ["brand/koincode-icon.svg", "brand/fcode-icon.svg"],
  ["brand/koincode-logo.svg", "brand/fcode-logo.svg"],
  ["brand/koincode-icon.svg", "apps/desktop/packages/ui/src/assets/fcode-icon.svg"],
  ["brand/koincode-logo.svg", "apps/desktop/packages/ui/src/assets/fcode-logo.svg"],
];
const inlineFiles = [
  `${desktop}/src/main/aboutWindow.ts`,
  `${desktop}/src/renderer/index.html`,
  // The wallet window is a standalone page whose CSP loads no images, so the mark is inlined.
  `${desktop}/src/renderer/public/wallet/index.html`,
  "apps/desktop/packages/web/index.html",
];
const pngCopies = [
  `${desktop}/build/icon.png`,
  `${desktop}/build/icon_windows.png`,
  `${desktop}/build/icon_installer.png`,
  "apps/desktop/public/icon_512@2x.png",
];
const outputs = [
  ...copies.map(([, target]) => target),
  "brand/koincode/icon-1024.png",
  "brand/koincode/logo-1440.png",
  ...pngCopies,
  ...sizes.flatMap((size) => [
    `${desktop}/build/icons/${size}x${size}.png`,
    `apps/desktop/public/logo/icons/${size}x${size}.png`,
  ]),
  `${desktop}/build/icon.ico`,
  `${desktop}/build/icon_installer.ico`,
  `${desktop}/build/icon.icns`,
  `${desktop}/build/icon_installer.icns`,
  "apps/desktop/public/logo/icons/icon.ico",
  "apps/desktop/public/logo/icons/icon.icns",
  "apps/desktop/packages/web/public/favicon.ico",
  `${desktop}/build/dmg_background.png`,
  `${desktop}/build/dmg_background@2x.png`,
];
const read = (file) => readFileSync(join(root, file));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iconDrawing = () =>
  read(sources[0])
    .toString()
    .match(/<(?:rect|path)\b[^>]*\/>/g)
    .join("\n");
const save = (file, bytes) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), bytes);
};
const copy = (source, target) => save(target, read(source));

function assertInline(file, drawing) {
  const content = read(file).toString();
  const compact = (value) => value.replace(/\s+/g, "");
  for (const element of drawing.split("\n")) {
    if (!compact(content).includes(compact(element)))
      throw new Error(`Stale inline brand artwork: ${file}`);
  }
  if (content.includes("M162 368") || content.includes("#42E5CC")) {
    throw new Error(`Retired brand artwork: ${file}`);
  }
  if (file.endsWith("web/index.html")) {
    if (
      !content.includes(`<title>KoinCode</title>`) ||
      !content.includes(encodeURIComponent(read(sources[0]).toString()))
    ) {
      throw new Error(`Stale web title or favicon: ${file}`);
    }
  }
}

export function checkBrandingAssets() {
  const manifest = JSON.parse(read(manifestPath));
  const expected = [...sources, ...outputs].sort();
  if (
    manifest.version !== 1 ||
    JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)
  ) {
    throw new Error("The branding manifest must include every source and export.");
  }
  for (const file of expected) {
    if (digest(read(file)) !== manifest.files[file])
      throw new Error(`Brand asset checksum mismatch: ${file}`);
  }
  for (const [source, target] of copies) {
    if (!read(source).equals(read(target))) throw new Error(`Brand copy differs: ${target}`);
  }
  for (const file of inlineFiles) assertInline(file, iconDrawing());
  console.log(
    `Branding assets verified: ${outputs.length} exports, ${inlineFiles.length} inline consumers.`,
  );
}

function createIco(pngs) {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...pngs.map(({ bytes }) => bytes)]);
}

function sync() {
  if (process.platform !== "darwin")
    throw new Error(
      "Author native assets on macOS with sips and iconutil; use --check on other platforms.",
    );
  const temporary = mkdtempSync(join(tmpdir(), "koincode-branding-"));
  const render = (source, target, size) => {
    mkdirSync(dirname(join(root, target)), { recursive: true });
    execFileSync(
      "sips",
      [
        "-s",
        "format",
        "png",
        ...(size ? ["-z", String(size), String(size)] : []),
        join(root, source),
        "--out",
        join(root, target),
      ],
      { stdio: "pipe" },
    );
  };
  try {
    for (const [source, target] of copies) copy(source, target);
    render(sources[0], "brand/koincode/icon-1024.png");
    render(sources[1], "brand/koincode/logo-1440.png");
    for (const target of pngCopies) copy("brand/koincode/icon-1024.png", target);
    for (const size of sizes) {
      const target = `${desktop}/build/icons/${size}x${size}.png`;
      render("brand/koincode/icon-1024.png", target, size);
      copy(target, `apps/desktop/public/logo/icons/${size}x${size}.png`);
    }
    const ico = createIco(
      sizes
        .filter((size) => size <= 256)
        .map((size) => ({ size, bytes: read(`${desktop}/build/icons/${size}x${size}.png`) })),
    );
    for (const target of outputs.filter((file) => file.endsWith(".ico"))) save(target, ico);
    const iconset = join(temporary, "KoinCode.iconset");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        copyFileSync(
          join(root, `${desktop}/build/icons/${size * scale}x${size * scale}.png`),
          join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        );
      }
    }
    const icns = join(temporary, "icon.icns");
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "pipe" });
    for (const target of outputs.filter((file) => file.endsWith(".icns")))
      save(target, readFileSync(icns));
    render(sources[2], `${desktop}/build/dmg_background.png`);
    const retina = join(temporary, "dmg.svg");
    writeFileSync(
      retina,
      read(sources[2]).toString().replace('width="540" height="380"', 'width="1080" height="760"'),
    );
    execFileSync(
      "sips",
      [
        "-s",
        "format",
        "png",
        retina,
        "--out",
        join(root, `${desktop}/build/dmg_background@2x.png`),
      ],
      { stdio: "pipe" },
    );
    for (const file of inlineFiles) {
      let content = read(file).toString();
      const matches = content.match(/<svg\b[\s\S]*?<\/svg>/g) ?? [];
      if (matches.length !== 1) throw new Error(`Expected one startup/about SVG in ${file}`);
      content = content.replace(
        /(<svg\b[^>]*>)[\s\S]*?<\/svg>/,
        (_, opening) =>
          `${opening}\n${matches[0].match(/<animate\b[^>]*\/>/)?.[0] ?? ""}\n${iconDrawing()}\n</svg>`,
      );
      if (file.endsWith("web/index.html")) {
        content = content.replace(/<title>[^<]*<\/title>/, "<title>KoinCode</title>");
        content = content.replace(
          /href="data:image\/svg\+xml,[^"]*"/,
          `href="data:image/svg+xml,${encodeURIComponent(read(sources[0]).toString())}"`,
        );
      }
      save(file, content);
    }
    save(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          files: Object.fromEntries(
            [...sources, ...outputs].sort().map((file) => [file, digest(read(file))]),
          ),
        },
        null,
        2,
      ) + "\n",
    );
    checkBrandingAssets();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check"))
      throw new Error("Usage: node scripts/sync-branding-assets.mjs [--check]");
    if (process.argv[2] === "--check") checkBrandingAssets();
    else sync();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
