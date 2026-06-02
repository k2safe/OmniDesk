import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const signingKeyPath = path.resolve(rootDir, process.env.SIGNING_KEY_PATH || ".tauri/omnidesk-updater.key");
const buildArgs = splitArgs(process.env.TAURI_BUILD_ARGS || "--bundles app");
const platform = resolvePlatform(buildArgs);
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(rootDir, "src-tauri/tauri.conf.json"), "utf8"));
const version = packageJson.version;
const productName = tauriConfig.productName || "OmniDesk";

if (!fs.existsSync(signingKeyPath)) {
  throw new Error(`Missing updater signing key: ${path.relative(rootDir, signingKeyPath)}`);
}

const signingKey = fs.readFileSync(signingKeyPath, "utf8");
if (!signingKey.trim()) {
  throw new Error(`Updater signing key is empty: ${path.relative(rootDir, signingKeyPath)}`);
}

run("pnpm", ["tauri", "build", ...buildArgs], {
  env: {
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PATH: signingKeyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""
  }
});

if (platform.platformId.startsWith("macos-")) {
  repairMacosBundle(platform, wantsBundle("dmg"));
}

run(process.execPath, ["scripts/collect-release-assets.mjs"], {
  env: {
    OMNIDESK_PLATFORM_ID: platform.platformId,
    OMNIDESK_UPDATER_PLATFORM: platform.updaterPlatform,
    OMNIDESK_BUNDLE_ROOT: platform.bundleRoot
  }
});

run(process.execPath, ["scripts/create-updater-latest.mjs", "dist-release"], {
  env: {
    OMNIDESK_RELEASE_REPO: process.env.RELEASES_REPO || "k2safe/OmniDesk",
    OMNIDESK_REQUIRED_PLATFORMS: process.env.OMNIDESK_REQUIRED_PLATFORMS || ""
  }
});

console.log(`Local release package ready in dist-release for ${platform.platformId}.`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options.env
    }
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function repairMacosBundle(platform, shouldBuildDmg) {
  const bundleRoot = path.resolve(rootDir, platform.bundleRoot);
  const macosDir = path.join(bundleRoot, "macos");
  const dmgDir = path.join(bundleRoot, "dmg");
  const appName = `${productName}.app`;
  const appPath = path.join(macosDir, appName);
  const updaterArchive = path.join(macosDir, `${appName}.tar.gz`);
  const updaterSignature = `${updaterArchive}.sig`;

  if (!fs.existsSync(appPath)) {
    throw new Error(`macOS app bundle not found: ${appPath}`);
  }

  run("xattr", ["-cr", appPath]);
  run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  fs.rmSync(updaterArchive, { force: true });
  fs.rmSync(updaterSignature, { force: true });
  run("tar", ["-czf", updaterArchive, "-C", macosDir, appName]);
  run("pnpm", ["tauri", "signer", "sign", "-f", signingKeyPath, "-p", "", updaterArchive]);

  if (shouldBuildDmg && fs.existsSync(dmgDir) && fs.existsSync(path.join(dmgDir, "bundle_dmg.sh"))) {
    for (const file of fs.readdirSync(dmgDir)) {
      if (file.endsWith(".dmg")) fs.rmSync(path.join(dmgDir, file), { force: true });
    }
    const dmgSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidesk-dmg."));
    fs.cpSync(appPath, path.join(dmgSourceDir, appName), { recursive: true });

    const dmgArch = platform.platformId === "macos-aarch64" ? "aarch64" : "x64";
    const dmgPath = path.join(dmgDir, `${productName}_${version}_${dmgArch}.dmg`);
    const dmgScript = path.join(dmgDir, "bundle_dmg.sh");
    const volIcon = path.join(dmgDir, "icon.icns");
    const dmgArgs = [
      "--volname",
      productName,
      "--volicon",
      volIcon,
      "--window-size",
      "660",
      "400",
      "--icon",
      appName,
      "180",
      "170",
      "--hide-extension",
      appName,
      "--app-drop-link",
      "480",
      "170",
      "--no-internet-enable",
      dmgPath,
      dmgSourceDir
    ];

    run(dmgScript, dmgArgs);
  }
}

function resolvePlatform(args) {
  const explicitPlatformId = process.env.OMNIDESK_PLATFORM_ID?.trim();
  const explicitUpdaterPlatform = process.env.OMNIDESK_UPDATER_PLATFORM?.trim();
  const explicitBundleRoot = process.env.OMNIDESK_BUNDLE_ROOT?.trim();
  const target = readTarget(args);
  const native = nativePlatform();

  if (explicitPlatformId && explicitUpdaterPlatform && explicitBundleRoot) {
    return {
      platformId: explicitPlatformId,
      updaterPlatform: explicitUpdaterPlatform,
      bundleRoot: explicitBundleRoot
    };
  }

  if (target) {
    return {
      ...platformFromRustTarget(target),
      bundleRoot: `src-tauri/target/${target}/release/bundle`
    };
  }

  return {
    ...native,
    bundleRoot: "src-tauri/target/release/bundle"
  };
}

function readTarget(args) {
  const targetIndex = args.findIndex((arg) => arg === "--target");
  if (targetIndex >= 0) return args[targetIndex + 1];

  const inline = args.find((arg) => arg.startsWith("--target="));
  if (inline) return inline.slice("--target=".length);

  return "";
}

function nativePlatform() {
  if (process.platform === "darwin") {
    return os.arch() === "arm64"
      ? { platformId: "macos-aarch64", updaterPlatform: "darwin-aarch64" }
      : { platformId: "macos-x86_64", updaterPlatform: "darwin-x86_64" };
  }

  if (process.platform === "win32") {
    return os.arch() === "arm64"
      ? { platformId: "windows-aarch64", updaterPlatform: "windows-aarch64" }
      : { platformId: "windows-x86_64", updaterPlatform: "windows-x86_64" };
  }

  throw new Error("Local desktop packaging currently supports macOS and Windows hosts.");
}

function platformFromRustTarget(target) {
  if (target === "aarch64-apple-darwin") {
    return { platformId: "macos-aarch64", updaterPlatform: "darwin-aarch64" };
  }
  if (target === "x86_64-apple-darwin") {
    return { platformId: "macos-x86_64", updaterPlatform: "darwin-x86_64" };
  }
  if (target === "aarch64-pc-windows-msvc") {
    return { platformId: "windows-aarch64", updaterPlatform: "windows-aarch64" };
  }
  if (target === "x86_64-pc-windows-msvc") {
    return { platformId: "windows-x86_64", updaterPlatform: "windows-x86_64" };
  }

  throw new Error(`Unsupported release target: ${target}`);
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, "")) ?? [];
}

function wantsBundle(bundleName) {
  const bundleArgIndex = buildArgs.findIndex((arg) => arg === "--bundles");
  if (bundleArgIndex >= 0) {
    return (buildArgs[bundleArgIndex + 1] || "").split(",").map((item) => item.trim()).includes(bundleName);
  }

  const inline = buildArgs.find((arg) => arg.startsWith("--bundles="));
  if (!inline) return false;
  return inline.slice("--bundles=".length).split(",").map((item) => item.trim()).includes(bundleName);
}
