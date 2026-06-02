import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(rootDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function nextVersion(current, bump = "patch") {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;

  const parts = current.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid semver: ${current}`);
  }

  const [major, minor, patch] = parts;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;

  throw new Error(`Unsupported version bump: ${bump}`);
}

const bump = process.argv[2] ?? "patch";
const packageJson = readJson("package.json");
const version = nextVersion(packageJson.version, bump);

packageJson.version = version;
writeJson("package.json", packageJson);

const tauriConfig = readJson("src-tauri/tauri.conf.json");
tauriConfig.version = version;
writeJson("src-tauri/tauri.conf.json", tauriConfig);

const cargoTomlPath = path.join(rootDir, "src-tauri/Cargo.toml");
const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
fs.writeFileSync(cargoTomlPath, cargoToml.replace(/^version = ".+"/m, `version = "${version}"`));

const cargoLockPath = path.join(rootDir, "src-tauri/Cargo.lock");
if (fs.existsSync(cargoLockPath)) {
  const cargoLock = fs.readFileSync(cargoLockPath, "utf8");
  fs.writeFileSync(
    cargoLockPath,
    cargoLock.replace(/(\[\[package\]\]\nname = "omnidesk"\nversion = ")[^"]+(")/, `$1${version}$2`)
  );
}

console.log(`OmniDesk version bumped to ${version}`);
