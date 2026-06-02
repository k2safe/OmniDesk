import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

const artifactsDir = path.resolve(process.argv[2] || "release-artifacts");
const releaseRepo = process.env.OMNIDESK_RELEASE_REPO || "k2safe/OmniDesk-releases";
const tagName = process.env.OMNIDESK_TAG_NAME || `app-v${packageJson.version}`;
const requiredPlatforms = (process.env.OMNIDESK_REQUIRED_PLATFORMS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!fs.existsSync(artifactsDir)) {
  throw new Error(`Artifacts directory not found: ${artifactsDir}`);
}

const metadataFiles = walk(artifactsDir).filter((file) => path.basename(file).startsWith("metadata-"));
if (metadataFiles.length === 0) {
  throw new Error(`No metadata files found under ${artifactsDir}`);
}

const platforms = {};
const assetNames = new Set();

for (const file of metadataFiles) {
  const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  const updaterPlatform = metadata.updaterPlatform;
  const updaterAsset = metadata.updater?.assetName;
  const signature = metadata.updater?.signature;

  if (!updaterPlatform || !updaterAsset || !signature) {
    throw new Error(`Invalid updater metadata: ${file}`);
  }
  if (platforms[updaterPlatform]) {
    throw new Error(`Duplicate updater platform metadata: ${updaterPlatform}`);
  }

  for (const asset of metadata.assets || []) {
    if (assetNames.has(asset.name)) {
      throw new Error(`Duplicate release asset name across platforms: ${asset.name}`);
    }
    assetNames.add(asset.name);
  }

  platforms[updaterPlatform] = {
    signature,
    url: `https://github.com/${releaseRepo}/releases/download/${tagName}/${encodeURIComponent(updaterAsset)}`
  };
}

const missingPlatforms = requiredPlatforms.filter((platform) => !platforms[platform]);
if (missingPlatforms.length > 0) {
  throw new Error(`Missing updater metadata for: ${missingPlatforms.join(", ")}`);
}

const latest = {
  version: packageJson.version,
  notes: `OmniDesk ${packageJson.version}`,
  pub_date: new Date().toISOString(),
  platforms
};

fs.writeFileSync(path.join(artifactsDir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`Created latest.json for ${Object.keys(platforms).length} platforms.`);

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}
