import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = packageJson.version;
const tagName = process.env.OMNIDESK_TAG_NAME || `app-v${version}`;
const releasesRepo = process.env.RELEASES_REPO || "k2safe/OmniDesk";
const artifactsDir = path.resolve(rootDir, process.env.OMNIDESK_RELEASE_ARTIFACTS || "dist-release");
const token = (process.env.RELEASES_REPO_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.TOKEN || "").trim();
const proxy = (process.env.PROXY ?? process.env.GIT_PROXY ?? "").trim();

if (!token) {
  throw new Error("TOKEN is required for publishing, e.g. make publish-local-release TOKEN=<github_token>");
}

if (!/^[^/]+\/[^/]+$/.test(releasesRepo)) {
  throw new Error(`Invalid RELEASES_REPO: ${releasesRepo}`);
}

if (!fs.existsSync(artifactsDir)) {
  throw new Error(`Release artifacts directory not found: ${path.relative(rootDir, artifactsDir)}`);
}

const releaseFiles = walk(artifactsDir)
  .filter((file) => fs.statSync(file).isFile())
  .filter((file) => !path.basename(file).startsWith("metadata-"))
  .sort();

if (releaseFiles.length === 0) {
  throw new Error(`No release files found under ${path.relative(rootDir, artifactsDir)}`);
}

if (!releaseFiles.some((file) => path.basename(file) === "latest.json")) {
  throw new Error("Missing dist-release/latest.json. Run make local-package first.");
}

const release = await upsertRelease();
await uploadReleaseFiles(release.id, releaseFiles);

console.log(`Published ${releaseFiles.length} files to ${releasesRepo} ${tagName}.`);

async function upsertRelease() {
  const existing = await githubJson(`/repos/${releasesRepo}/releases/tags/${encodeURIComponent(tagName)}`, {
    allowNotFound: true
  });
  const payload = {
    name: `OmniDesk v${version}`,
    body: "OmniDesk desktop installers and updater artifacts. Download the installer for your operating system and CPU architecture.",
    make_latest: "true"
  };

  if (existing) {
    return githubJson(`/repos/${releasesRepo}/releases/${existing.id}`, {
      method: "PATCH",
      body: payload
    });
  }

  return githubJson(`/repos/${releasesRepo}/releases`, {
    method: "POST",
    body: {
      tag_name: tagName,
      target_commitish: "main",
      ...payload
    }
  });
}

async function uploadReleaseFiles(releaseId, files) {
  const assets = await githubJson(`/repos/${releasesRepo}/releases/${releaseId}/assets?per_page=100`);
  const assetByName = new Map(assets.map((asset) => [asset.name, asset]));

  for (const file of files) {
    const name = path.basename(file);
    const existingAsset = assetByName.get(name);
    if (existingAsset) {
      await githubRaw(`/repos/${releasesRepo}/releases/assets/${existingAsset.id}`, { method: "DELETE" });
    }

    await githubUpload(`/repos/${releasesRepo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, file);
    console.log(`Uploaded ${name}`);
  }
}

async function githubJson(apiPath, options = {}) {
  const response = githubRaw(apiPath, {
    method: options.method || "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    allowNotFound: options.allowNotFound
  });

  if (!response || response.status === 204 || !response.body.trim()) return null;
  return JSON.parse(response.body);
}

async function githubUpload(apiPath, file) {
  const response = githubRaw(apiPath, {
    host: "https://uploads.github.com",
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    file
  });
  return response.body.trim() ? JSON.parse(response.body) : null;
}

function githubRaw(apiPath, options = {}) {
  const host = options.host || "https://api.github.com";
  const args = [
    "-sS",
    "-L",
    "-w",
    "\n__HTTP_STATUS__:%{http_code}",
    "-X",
    options.method || "GET",
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28"
  ];

  for (const [name, value] of Object.entries(options.headers || {})) {
    args.push("-H", `${name}: ${value}`);
  }

  if (options.body) {
    args.push("--data-binary", options.body);
  }
  if (options.file) {
    args.push("--data-binary", `@${options.file}`);
  }
  if (proxy) {
    args.push("--proxy", proxy);
  }

  args.push(`${host}${apiPath}`);

  const result = spawnSync("curl", args, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`curl failed: ${(result.stderr || result.stdout).trim()}`);
  }

  const marker = "\n__HTTP_STATUS__:";
  const markerIndex = result.stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`GitHub API response missing status marker: ${result.stdout}`);
  }

  const body = result.stdout.slice(0, markerIndex);
  const status = Number.parseInt(result.stdout.slice(markerIndex + marker.length).trim(), 10);

  if (options.allowNotFound && status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new Error(`GitHub API failed ${status}: ${body || result.stderr}`);
  }

  return { status, body };
}

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
