import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bump = process.env.BUMP || "patch";
const shouldBumpVersion = !["current", "none", "skip"].includes(bump);
const shouldPushCode = process.env.PUSH !== "0";
const token = (process.env.TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();

if (!token) {
  throw new Error("TOKEN is required, e.g. make local-mac-release TOKEN=<github_token>");
}

if (shouldBumpVersion) {
  run(process.execPath, ["scripts/bump-version.mjs", bump]);
}

run(process.execPath, ["scripts/package-local-release.mjs"], {
  env: {
    SIGNING_KEY_PATH: process.env.SIGNING_KEY_PATH || ".tauri/omnidesk-updater.key",
    TAURI_BUILD_ARGS: process.env.TAURI_BUILD_ARGS || "--bundles app",
    RELEASES_REPO: process.env.RELEASES_REPO || "k2safe/OmniDesk-releases"
  }
});

run(process.execPath, ["scripts/publish-local-release.mjs"], {
  env: {
    TOKEN: token,
    PROXY: process.env.PROXY || "",
    RELEASES_REPO: process.env.RELEASES_REPO || "k2safe/OmniDesk-releases"
  }
});

if (shouldPushCode) {
  pushCodeIfPossible();
}

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

function git(commandArgs, options = {}) {
  const result = spawnSync("git", commandArgs, {
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

function pushCodeIfPossible() {
  if (!isGitRepo()) {
    console.log("Code push skipped: this working directory is not a git repository. Release assets were still uploaded.");
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const tagName = `app-v${packageJson.version}`;

  git(["add", "."]);
  const diff = git(["diff", "--cached", "--quiet"], { stdio: "ignore", allowFailure: true });
  if (diff.status !== 0) {
    git(["commit", "-m", shouldBumpVersion ? `Release v${packageJson.version}` : `Push release v${packageJson.version}`]);
  }

  if (shouldBumpVersion) {
    git(["tag", "-f", tagName]);
  } else {
    const existingTag = git(["rev-parse", "-q", "--verify", `refs/tags/${tagName}`], {
      stdio: "ignore",
      allowFailure: true
    });
    if (existingTag.status !== 0) {
      git(["tag", tagName]);
    }
  }

  git(["push", "origin", "HEAD:main"]);
  git(["push", "origin", `refs/tags/${tagName}`, "--force"]);
}
