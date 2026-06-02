import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bump = process.env.VERSION || process.env.BUMP || "patch";
const shouldBumpVersion = !["current", "none", "skip"].includes(bump);
const shouldPushCode = process.env.PUSH !== "0";
const shouldPublish = process.env.PUBLISH !== "0";
const shouldBuildDmg = process.env.SKIP_DMG !== "1";
const token = (process.env.TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
const proxy = (process.env.PROXY || process.env.GIT_PROXY || "").trim();
const releasesRepo = process.env.RELEASES_REPO || "k2safe/OmniDesk";
const signingKeyPath = process.env.SIGNING_KEY_PATH || ".tauri/omnidesk-updater.key";
const remote = process.env.GITHUB_REMOTE || "origin";

if (shouldPublish && !token) {
  throw new Error("TOKEN is required, e.g. make desktop-release TOKEN=<github_token>");
}

if (shouldBumpVersion) {
  run(process.execPath, ["scripts/bump-version.mjs", bump]);
}

ensureNodeModules();

const version = readPackageVersion();
const tagName = `app-v${version}`;
const platformId = nativeMacPlatformId();
const updaterBaseUrl =
  process.env.OMNIDESK_UPDATER_BASE_URL ||
  `https://raw.githubusercontent.com/${releasesRepo}/main/updates/${tagName}`;

run(process.execPath, ["scripts/package-local-release.mjs"], {
  env: {
    SIGNING_KEY_PATH: signingKeyPath,
    TAURI_BUILD_ARGS: "--bundles app",
    RELEASES_REPO: releasesRepo,
    OMNIDESK_UPDATER_BASE_URL: updaterBaseUrl
  }
});

if (shouldBuildDmg) {
  buildSimpleDmg(version, platformId);
}
copyUpdaterAssets(version, platformId);

if (shouldPushCode) {
  pushCodeIfPossible(version, tagName);
} else {
  console.log("Code push skipped because PUSH=0.");
}

if (shouldPublish) {
  run(process.execPath, ["scripts/publish-local-release.mjs"], {
    env: {
      TOKEN: token,
      PROXY: proxy,
      RELEASES_REPO: releasesRepo
    }
  });
} else {
  console.log("GitHub release upload skipped because PUBLISH=0.");
}

console.log(`Desktop release ${tagName} is ready.`);

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
}

function ensureNodeModules() {
  if (fs.existsSync(path.join(rootDir, "node_modules"))) return;
  run("pnpm", ["install", "--frozen-lockfile"]);
}

function buildSimpleDmg(version, platformId) {
  if (process.platform !== "darwin") return;

  const appPath = path.join(rootDir, "src-tauri/target/release/bundle/macos/OmniDesk.app");
  if (!fs.existsSync(appPath)) {
    throw new Error(`macOS app bundle not found: ${path.relative(rootDir, appPath)}`);
  }

  const distDir = path.join(rootDir, "dist-release");
  fs.mkdirSync(distDir, { recursive: true });

  const dmgPath = path.join(distDir, `OmniDesk-v${version}-${platformId}.dmg`);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnidesk-dmg."));

  try {
    fs.cpSync(appPath, path.join(stagingDir, "OmniDesk.app"), { recursive: true });
    fs.symlinkSync("/Applications", path.join(stagingDir, "Applications"));

    const args = ["create", "-volname", "OmniDesk", "-srcfolder", stagingDir, "-ov", "-format", "UDZO", dmgPath];
    const direct = run("hdiutil", args, { allowFailure: true });
    if (direct.status !== 0) {
      const appleScript = `do shell script ${appleScriptString(commandLine("hdiutil", args))}`;
      run("osascript", ["-e", appleScript]);
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function copyUpdaterAssets(version, platformId) {
  const distDir = path.join(rootDir, "dist-release");
  const updateDir = path.join(rootDir, "updates", `app-v${version}`);
  const updaterName = `OmniDesk-v${version}-${platformId}.app.tar.gz`;
  const signatureName = `${updaterName}.sig`;

  for (const file of [updaterName, signatureName, "latest.json"]) {
    const source = path.join(distDir, file);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing release artifact: ${path.relative(rootDir, source)}`);
    }
  }

  fs.mkdirSync(updateDir, { recursive: true });
  fs.copyFileSync(path.join(distDir, updaterName), path.join(updateDir, updaterName));
  fs.copyFileSync(path.join(distDir, signatureName), path.join(updateDir, signatureName));
  fs.copyFileSync(path.join(distDir, "latest.json"), path.join(rootDir, "updates/latest.json"));
}

function pushCodeIfPossible(version, tagName) {
  if (!isGitRepo()) {
    console.log("Code push skipped: this working directory is not a git repository. Release assets were still uploaded.");
    return;
  }

  git([
    "add",
    "Makefile",
    "package.json",
    "pnpm-lock.yaml",
    "scripts",
    "src",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "src-tauri/capabilities",
    "src-tauri/icons",
    "src-tauri/src",
    "updates"
  ]);

  const diff = git(["diff", "--cached", "--quiet"], { stdio: "ignore", allowFailure: true });
  if (diff.status !== 0) {
    git(["commit", "-m", shouldBumpVersion ? `Release v${version}` : `Push release v${version}`]);
  }

  git(["tag", "-f", tagName]);
  git(["push", remote, "HEAD:main"]);
  git(["push", remote, `refs/tags/${tagName}`, "--force"]);
}

function nativeMacPlatformId() {
  if (process.platform !== "darwin") {
    throw new Error("local-mac-release only supports macOS hosts.");
  }
  return os.arch() === "arm64" ? "macos-aarch64" : "macos-x86_64";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: options.stdio ?? "inherit",
    env: {
      ...process.env,
      ...options.env
    }
  });

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }

  return result;
}

function gitArgs() {
  const args = [];
  if (proxy) {
    args.push("-c", `http.proxy=${proxy}`, "-c", `https.proxy=${proxy}`);
  }
  if (token) {
    const header = Buffer.from(`x-access-token:${token}`).toString("base64");
    args.push("-c", `http.https://github.com/.extraheader=AUTHORIZATION: Basic ${header}`);
  }
  return args;
}

function git(commandArgs, options = {}) {
  const result = spawnSync("git", [...gitArgs(), ...commandArgs], {
    cwd: rootDir,
    stdio: options.stdio ?? "inherit",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0"
    }
  });

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }

  return result;
}

function isGitRepo() {
  return fs.existsSync(path.join(rootDir, ".git"));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandLine(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
