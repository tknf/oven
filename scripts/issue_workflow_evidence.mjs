import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = "origin/main";
const secretPathspecs = [
	":(glob)**/.env",
	":(glob)**/.env.*",
	":(glob)**/.dev.vars",
	":(glob)**/.dev.vars.*",
	":(glob)**/secrets/**",
];

const git = (args, stderr = "inherit") =>
	execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", stderr],
	});

const gitOrNull = (args) => {
	try {
		return git(args, "ignore").trim();
	} catch {
		return null;
	}
};

const gitSucceeds = (args) => {
	try {
		git(args, "ignore");
		return true;
	} catch {
		return false;
	}
};

const splitNull = (source) => source.split("\0").filter((value) => value.length > 0);

const isSecretPath = (path) => {
	const parts = path.split("/");
	const basename = parts.at(-1) ?? "";
	return (
		parts.includes("secrets") ||
		basename === ".env" ||
		(basename.startsWith(".env.") && basename !== ".env.example") ||
		basename === ".dev.vars" ||
		(basename.startsWith(".dev.vars.") && basename !== ".dev.vars.example")
	);
};

const head = git(["rev-parse", "HEAD"]).trim();
const branch = git(["branch", "--show-current"]).trim();
const baseHead = gitOrNull(["rev-parse", "--verify", baseRef]);
const baseIsAncestor = baseHead
	? gitSucceeds(["merge-base", "--is-ancestor", baseRef, "HEAD"])
	: false;
const upstreamRef = gitOrNull(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
const upstreamHead = gitOrNull(["rev-parse", "--verify", "@{upstream}"]);
const remoteBranchRef = branch.length > 0 ? `origin/${branch}` : null;
const remoteBranchHead = remoteBranchRef
	? gitOrNull(["rev-parse", "--verify", remoteBranchRef])
	: null;
const outgoingCommits = baseHead
	? git(["rev-list", "--reverse", `${baseHead}..HEAD`])
			.split("\n")
			.filter((commit) => commit.length > 0)
	: [];

const trackedSecretPaths = splitNull(git(["ls-files", "--cached", "-z", "--", ...secretPathspecs]));
const ignoredSecretPaths = splitNull(
	git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...secretPathspecs]),
);
const secretPaths = [...new Set([...trackedSecretPaths, ...ignoredSecretPaths])]
	.filter(isSecretPath)
	.sort((a, b) => a.localeCompare(b));
const secretStateHash = createHash("sha256");

for (const path of secretPaths) {
	const absolutePath = resolve(root, path);
	if (!absolutePath.startsWith(`${root}/`) || !existsSync(absolutePath)) continue;
	const stat = lstatSync(absolutePath, { bigint: true });
	const kind = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
	secretStateHash.update(
		[
			path,
			kind,
			stat.mode.toString(),
			stat.size.toString(),
			stat.mtimeNs.toString(),
			stat.ctimeNs.toString(),
			stat.ino.toString(),
		].join("\0"),
	);
}

const secretStateFingerprint = secretStateHash.digest("hex");
const stagedPaths = [
	...new Set(splitNull(git(["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"]))),
].sort((a, b) => a.localeCompare(b));
const worktreePaths = splitNull(git(["diff", "--name-only", "--no-renames", "-z"]));
const untrackedPaths = splitNull(git(["ls-files", "--others", "--exclude-standard", "-z"])).sort(
	(a, b) => a.localeCompare(b),
);
const unstagedPaths = [...new Set([...worktreePaths, ...untrackedPaths])].sort((a, b) =>
	a.localeCompare(b),
);
const statusEntries = splitNull(
	git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
).sort();
const changedPaths = [...new Set([...stagedPaths, ...unstagedPaths])].sort((a, b) =>
	a.localeCompare(b),
);
const unsafePaths = changedPaths.filter(isSecretPath);
const readContentWhenSafe = (readContent, fallback) =>
	unsafePaths.length === 0 ? readContent() : fallback;
const indexDiff = readContentWhenSafe(() => git(["diff", "--cached", "--binary", "HEAD"]), "");
const worktreeDiff = readContentWhenSafe(() => git(["diff", "--binary"]), "");

const stateHash = createHash("sha256");
stateHash.update(
	["index", indexDiff, "worktree", worktreeDiff, "status", statusEntries.join("\n")].join("\0"),
);

const updatePathContent = (targetHash, paths) => {
	const contentRead = readContentWhenSafe(() => {
		for (const path of paths) {
			targetHash.update(`\0path:${path}\0`);
			const absolutePath = resolve(root, path);
			if (!absolutePath.startsWith(`${root}/`)) {
				targetHash.update("outside-root");
				continue;
			}

			let stat;
			try {
				stat = lstatSync(absolutePath);
			} catch {
				targetHash.update("absent");
				continue;
			}

			if (stat.isSymbolicLink()) {
				targetHash.update(`symlink:${readlinkSync(absolutePath)}`);
			} else if (stat.isFile()) {
				targetHash.update((stat.mode & 0o111) === 0 ? "file:regular" : "file:executable");
				targetHash.update(readFileSync(absolutePath));
			} else {
				targetHash.update(`mode:${stat.mode}`);
			}
		}
		return true;
	}, false);

	if (!contentRead) targetHash.update("unsafe-content-not-read");
};

updatePathContent(stateHash, untrackedPaths);
const contentHash = createHash("sha256");
contentHash.update(["head", head].join("\0"));
updatePathContent(contentHash, changedPaths);

console.log(
	JSON.stringify({
		branch,
		head,
		baseRef,
		baseHead,
		baseIsAncestor,
		upstreamRef,
		upstreamHead,
		remoteBranchRef,
		remoteBranchHead,
		outgoingCommits,
		secretStateFingerprint,
		fingerprint: stateHash.digest("hex"),
		contentFingerprint: contentHash.digest("hex"),
		changedPaths,
		stagedPaths,
		unstagedPaths,
		statusEntries,
		unsafePaths,
	}),
);
