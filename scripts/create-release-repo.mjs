const token = (process.env.TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
const repoSlug = (process.env.RELEASES_REPO || "k2safe/OmniDesk").trim();

if (!token) {
  console.error("Missing TOKEN, GITHUB_TOKEN, or GH_TOKEN.");
  process.exit(1);
}

const [owner, name] = repoSlug.split("/");
if (!owner || !name) {
  console.error(`Invalid RELEASES_REPO: ${repoSlug}`);
  process.exit(1);
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

try {
  const existing = await github(`/repos/${owner}/${name}`).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });

  if (existing) {
    if (!existing.private) {
      console.log(`${repoSlug} already exists and is public.`);
      process.exit(0);
    }

    console.error(`${repoSlug} already exists but is private. Please make it public or choose another RELEASES_REPO.`);
    process.exit(1);
  }

  const user = await github("/user");
  const repoPath = user.login === owner ? "/user/repos" : `/orgs/${owner}/repos`;
  const created = await github(repoPath, {
    method: "POST",
    body: JSON.stringify({
      name,
      private: false,
      auto_init: true,
      description: "Public release artifacts for OmniDesk desktop updater",
      has_issues: false,
      has_projects: false,
      has_wiki: false
    })
  });

  console.log(`Created public release repository: ${created.html_url}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
