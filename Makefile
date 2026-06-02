SHELL := /bin/bash
.DEFAULT_GOAL := h

BUMP ?= patch
PROXY ?= http://127.0.0.1:10021
TOKEN ?=
PUSH ?= 1
REPO ?= k2safe/OmniDesk
RELEASES_REPO ?= k2safe/OmniDesk-releases
SIGNING_KEY_PATH ?= .tauri/omnidesk-updater.key
TAURI_BUILD_ARGS ?= --bundles dmg,app

.PHONY: h help build package local-package publish-local-release local-mac-release release push-release create-release-repo github-secrets

h help:
	@printf '%s\n' \
		'OmniDesk 常用命令' \
		'' \
		'  make build' \
		'      构建前端产物，用来检查 TypeScript 和 Vite 是否通过。' \
		'' \
		'  make package / make local-package' \
		'      本机打桌面包，并把安装包、updater 压缩包、.sig、latest.json 收集到 dist-release。' \
		'      默认打 macOS dmg/app，可选：TAURI_BUILD_ARGS="--bundles dmg,app"。' \
		'' \
		'  make publish-local-release TOKEN=<github_token>' \
		'      把 dist-release 上传到公开仓库 k2safe/OmniDesk-releases 的 GitHub Release。' \
		'      TOKEN 需要有 k2safe/OmniDesk-releases 的 Contents: Read and write 权限。' \
		'' \
		'  make local-mac-release BUMP=patch TOKEN=<github_token>' \
		'      推荐发版命令：升级版本、本机打 macOS 包、上传公开 Release、推送代码和 app-vX.Y.Z tag。' \
		'' \
		'  make release BUMP=patch' \
		'      只升级版本、构建、提交、打 app-vX.Y.Z tag，并推送代码/tag；不会本地打包。' \
		'      BUMP 可用：patch、minor、major，或精确版本号，例如 BUMP=0.1.3。' \
		'      可选：PROXY=http://127.0.0.1:10021 PUSH=0 TOKEN=<github_token>。' \
		'' \
		'  make push-release' \
		'      不升级版本，直接推送当前 package.json 里的版本和 app-vX.Y.Z tag。' \
		'' \
		'  make create-release-repo TOKEN=<github_token>' \
		'      创建公开发布仓库 k2safe/OmniDesk-releases，只用于放安装包、.sig 和 latest.json。' \
		'' \
		'  make github-secrets TOKEN=<github_token>' \
		'      把 updater 签名私钥和公开发布仓库 token 写入私有代码仓库的 GitHub Secrets。'

build:
	pnpm build

package local-package:
	@SIGNING_KEY_PATH="$(SIGNING_KEY_PATH)" TAURI_BUILD_ARGS="$(TAURI_BUILD_ARGS)" RELEASES_REPO="$(RELEASES_REPO)" node scripts/package-local-release.mjs

publish-local-release:
	@TOKEN="$(TOKEN)" PROXY="$(PROXY)" RELEASES_REPO="$(RELEASES_REPO)" node scripts/publish-local-release.mjs

local-mac-release:
	@TOKEN="$(TOKEN)" GIT_PROXY="$(PROXY)" BUMP="$(BUMP)" PUSH=0 node scripts/release.mjs
	@SIGNING_KEY_PATH="$(SIGNING_KEY_PATH)" TAURI_BUILD_ARGS="$(TAURI_BUILD_ARGS)" RELEASES_REPO="$(RELEASES_REPO)" node scripts/package-local-release.mjs
	@TOKEN="$(TOKEN)" PROXY="$(PROXY)" RELEASES_REPO="$(RELEASES_REPO)" node scripts/publish-local-release.mjs
	@TOKEN="$(TOKEN)" GIT_PROXY="$(PROXY)" BUMP=current PUSH="$(PUSH)" node scripts/release.mjs

release:
	@TOKEN="$(TOKEN)" GIT_PROXY="$(PROXY)" BUMP="$(BUMP)" PUSH="$(PUSH)" node scripts/release.mjs

push-release:
	@TOKEN="$(TOKEN)" GIT_PROXY="$(PROXY)" BUMP="current" PUSH="$(PUSH)" node scripts/release.mjs

create-release-repo:
	@test -n "$(TOKEN)" || (echo "TOKEN is required, e.g. make create-release-repo TOKEN=<github_token>" && exit 1)
	@TOKEN="$(TOKEN)" RELEASES_REPO="$(RELEASES_REPO)" node scripts/create-release-repo.mjs

github-secrets:
	@test -n "$(TOKEN)" || (echo "TOKEN is required, e.g. make github-secrets TOKEN=<github_token>" && exit 1)
	@test -f "$(SIGNING_KEY_PATH)" || (echo "Missing $(SIGNING_KEY_PATH). Generate the updater signing key first." && exit 1)
	@GH_TOKEN="$(TOKEN)" gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$(REPO)" --body-file "$(SIGNING_KEY_PATH)"
	@GH_TOKEN="$(TOKEN)" gh secret set RELEASES_REPO_TOKEN --repo "$(REPO)" --body "$(TOKEN)"
	@GH_TOKEN="$(TOKEN)" gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$(REPO)" || true
