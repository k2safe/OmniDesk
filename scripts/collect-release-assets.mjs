import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

const version = packageJson.version;
const platformId = mustEnv("OMNIDESK_PLATFORM_ID");
const updaterPlatform = mustEnv("OMNIDESK_UPDATER_PLATFORM");
const bundleRoot = path.resolve(rootDir, mustEnv("OMNIDESK_BUNDLE_ROOT"));
const outputDir = path.join(rootDir, "dist-release");

if (!fs.existsSync(bundleRoot)) {
  throw new Error(`Bundle output not found: ${bundleRoot}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const copied = [];
const seenNames = new Set();

for (const file of walk(bundleRoot)) {
  if (!fs.statSync(file).isFile()) continue;

  const classification = classifyBundleAsset(path.basename(file));
  if (!classification) continue;

  const targetName = `OmniDesk-v${version}-${platformId}${classification.suffix}`;
  if (seenNames.has(targetName)) {
    throw new Error(`Duplicate release asset name: ${targetName}`);
  }

  seenNames.add(targetName);
  const targetPath = path.join(outputDir, targetName);
  fs.copyFileSync(file, targetPath);

  copied.push({
    name: targetName,
    source: path.relative(rootDir, file),
    kind: classification.kind,
    updaterPriority: classification.updaterPriority
  });
}

if (copied.length === 0) {
  throw new Error(`No releasable bundle assets found under ${bundleRoot}`);
}

const updaterSignature = copied
  .filter((asset) => asset.name.endsWith(".sig"))
  .sort((a, b) => b.updaterPriority - a.updaterPriority)[0];

if (!updaterSignature) {
  throw new Error(`No updater signature artifact found for ${platformId}`);
}

const updaterAssetName = updaterSignature.name.slice(0, -".sig".length);
const updaterAsset = copied.find((asset) => asset.name === updaterAssetName);
if (!updaterAsset) {
  throw new Error(`Updater signature ${updaterSignature.name} has no matching asset ${updaterAssetName}`);
}

const signature = fs.readFileSync(path.join(outputDir, updaterSignature.name), "utf8").trim();
if (!signature) {
  throw new Error(`Updater signature is empty: ${updaterSignature.name}`);
}

const metadata = {
  version,
  platformId,
  updaterPlatform,
  updater: {
    assetName: updaterAsset.name,
    signatureAssetName: updaterSignature.name,
    signature
  },
  assets: copied
};

fs.writeFileSync(path.join(outputDir, `metadata-${platformId}.json`), `${JSON.stringify(metadata, null, 2)}\n`);

console.log(`Collected ${copied.length} release assets for ${platformId}.`);

function mustEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

function classifyBundleAsset(fileName) {
  if (fileName === ".DS_Store" || fileName === "bundle_dmg.sh") return null;

  if (fileName.endsWith(".app.tar.gz.sig")) {
    return { suffix: ".app.tar.gz.sig", kind: "macos-updater-signature", updaterPriority: 100 };
  }
  if (fileName.endsWith(".app.tar.gz")) {
    return { suffix: ".app.tar.gz", kind: "macos-updater", updaterPriority: 0 };
  }
  if (fileName.endsWith(".dmg")) {
    if (!fileName.includes(version)) return null;
    return { suffix: ".dmg", kind: "macos-installer", updaterPriority: 0 };
  }
  if (fileName.endsWith(".nsis.zip.sig")) {
    return { suffix: ".nsis.zip.sig", kind: "windows-updater-signature", updaterPriority: 95 };
  }
  if (fileName.endsWith(".nsis.zip")) {
    return { suffix: ".nsis.zip", kind: "windows-updater", updaterPriority: 0 };
  }
  if (fileName.endsWith(".msi.zip.sig")) {
    return { suffix: ".msi.zip.sig", kind: "windows-updater-signature", updaterPriority: 90 };
  }
  if (fileName.endsWith(".msi.zip")) {
    return { suffix: ".msi.zip", kind: "windows-updater", updaterPriority: 0 };
  }
  if (fileName.endsWith(".exe.sig")) {
    if (!fileName.includes(version)) return null;
    return { suffix: "-setup.exe.sig", kind: "windows-installer-signature", updaterPriority: 85 };
  }
  if (fileName.endsWith(".exe")) {
    if (!fileName.includes(version)) return null;
    return { suffix: "-setup.exe", kind: "windows-installer", updaterPriority: 0 };
  }
  if (fileName.endsWith(".msi.sig")) {
    if (!fileName.includes(version)) return null;
    return { suffix: ".msi.sig", kind: "windows-installer-signature", updaterPriority: 80 };
  }
  if (fileName.endsWith(".msi")) {
    if (!fileName.includes(version)) return null;
    return { suffix: ".msi", kind: "windows-installer", updaterPriority: 0 };
  }

  return null;
}
