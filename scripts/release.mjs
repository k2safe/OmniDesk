import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: options.stdio ?? "inherit",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...options.env
    }
  });

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }

  return result;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function gitArgs() {
  const args = [];
  const proxy = (process.env.GIT_PROXY || process.env.PROXY || "").trim();
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.TOKEN || "").trim();

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
  return run("git", [...gitArgs(), ...commandArgs], options);
}

const bump = process.argv[2] || process.env.BUMP || "patch";
const shouldBumpVersion = !["current", "none", "skip"].includes(bump);
const shouldPush = process.env.PUSH !== "0";
const remote = process.env.GITHUB_REMOTE || "git@github.com:k2safe/OmniDesk.git";

if (shouldBumpVersion) {
  run(process.execPath, ["scripts/bump-version.mjs", bump]);
}

const version = readJson("package.json").version;
const tagName = `app-v${version}`;

run("pnpm", ["build"]);

git(["add", "."]);

const diff = git(["diff", "--cached", "--quiet"], { stdio: "ignore", allowFailure: true });
if (diff.status !== 0) {
  git(["commit", "-m", shouldBumpVersion ? `Release v${version}` : `Push release v${version}`]);
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

if (shouldPush) {
  git(["push", remote, "HEAD:main"]);
  git(["push", remote, `refs/tags/${tagName}`, "--force"]);
  console.log(`Pushed ${tagName}. Run make local-package or the Build Desktop workflow when you need installers.`);
} else {
  console.log(`Prepared ${tagName}. Push skipped because PUSH=0.`);
}
