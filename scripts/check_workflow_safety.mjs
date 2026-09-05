import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const read = (relativePath) => readFileSync(resolve(root, relativePath), "utf8");
const run = (command, args, cwd) =>
	execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});

const snapshotTree = (rootPath) => {
	const entries = [];
	const visit = (currentPath) => {
		const stat = lstatSync(currentPath, { bigint: true });
		entries.push(
			[
				relative(rootPath, currentPath) || ".",
				stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
				stat.mode.toString(),
				stat.size.toString(),
				stat.mtimeNs.toString(),
				stat.ctimeNs.toString(),
			].join("\0"),
		);
		if (!stat.isDirectory()) return;
		for (const entry of readdirSync(currentPath)) visit(join(currentPath, entry));
	};
	visit(rootPath);
	return entries.sort((a, b) => a.localeCompare(b));
};

const setTreeReadOnly = (currentPath) => {
	const stat = lstatSync(currentPath);
	if (stat.isSymbolicLink()) return;
	if (stat.isDirectory()) {
		for (const entry of readdirSync(currentPath)) setTreeReadOnly(join(currentPath, entry));
		chmodSync(currentPath, 0o555);
	} else {
		chmodSync(currentPath, 0o444);
	}
};

const setTreeWritable = (currentPath) => {
	const stat = lstatSync(currentPath);
	if (stat.isSymbolicLink()) return;
	if (stat.isDirectory()) {
		chmodSync(currentPath, 0o755);
		for (const entry of readdirSync(currentPath)) setTreeWritable(join(currentPath, entry));
	} else {
		chmodSync(currentPath, 0o644);
	}
};

const requiredFiles = [
	"AGENTS.md",
	"scripts/check_workflow_safety.mjs",
	"scripts/issue_workflow_evidence.mjs",
	"scripts/issue_workflow_gate.mjs",
	".agents/skills/issue/references/git-safety.md",
	".codex/agents/auditor.toml",
	".codex/agents/researcher.toml",
	".codex/agents/reviewer.toml",
	".codex/agents/worker.toml",
];
const forbiddenLegacyFiles = [
	".codex/agents/planner.toml",
	".codex/agents/implementer.toml",
	".codex/agents/integrator.toml",
	".codex/agents/release_manager.toml",
	".agents/skills/issue/references/phase-handoff.md",
];

for (const path of requiredFiles) {
	if (!existsSync(resolve(root, path))) errors.push(`Missing required workflow file: ${path}`);
}
for (const path of forbiddenLegacyFiles) {
	if (existsSync(resolve(root, path))) errors.push(`Legacy workflow file still exists: ${path}`);
}

const packageJson = JSON.parse(read("package.json"));
const expectedScripts = {
	"check:workflow-safety": "node scripts/check_workflow_safety.mjs",
	"workflow:evidence": "node scripts/issue_workflow_evidence.mjs",
	"workflow:gate": "node scripts/issue_workflow_gate.mjs",
};
for (const [name, command] of Object.entries(expectedScripts)) {
	if (packageJson.scripts?.[name] !== command) {
		errors.push(`package.json has an invalid ${name} script`);
	}
}

const expectedAgents = ["auditor.toml", "researcher.toml", "reviewer.toml", "worker.toml"];
const actualAgents = readdirSync(resolve(root, ".codex/agents"))
	.filter((path) => path.endsWith(".toml"))
	.sort();
if (JSON.stringify(actualAgents) !== JSON.stringify(expectedAgents)) {
	errors.push(`Unexpected custom agent catalog: ${actualAgents.join(", ")}`);
}
for (const file of expectedAgents) {
	const source = read(`.codex/agents/${file}`);
	const expectedName = file.slice(0, -".toml".length);
	const configuredName = source.match(/^name = "([^"]+)"$/m)?.[1];
	if (configuredName !== expectedName) {
		errors.push(`${file} name must match its filename`);
	}
	const expectedSandbox = file === "worker.toml" ? "workspace-write" : "read-only";
	if (!source.includes(`sandbox_mode = "${expectedSandbox}"`)) {
		errors.push(`${file} must use ${expectedSandbox}`);
	}
}

const expectedSkills = ["impl", "issue", "issue-slop-check", "plan", "release", "review", "wrapup"];
const actualSkills = readdirSync(resolve(root, ".agents/skills"))
	.filter((name) => existsSync(resolve(root, ".agents/skills", name, "SKILL.md")))
	.sort();
if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
	errors.push(`Unexpected workflow skill catalog: ${actualSkills.join(", ")}`);
}

for (const name of expectedSkills) {
	const source = read(`.agents/skills/${name}/SKILL.md`);
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	const configuredName = frontmatter.match(/^name:\s*([^\s]+)\s*$/m)?.[1];
	if (configuredName !== name) {
		errors.push(`${name}/SKILL.md frontmatter name must match its directory`);
	}
}

const reviewerSource = read(".codex/agents/reviewer.toml");
const reviewSkillSource = read(".agents/skills/review/SKILL.md");
const orchestrationSources = [
	["AGENTS.md", read("AGENTS.md")],
	...expectedSkills.map((name) => [
		`.agents/skills/${name}/SKILL.md`,
		read(`.agents/skills/${name}/SKILL.md`),
	]),
];
for (const [relativePath, source] of orchestrationSources) {
	for (const legacyTerm of [
		"`planner`",
		"`implementer`",
		"`integrator`",
		"`release_manager`",
		"PHASE_RESULT",
		"phase-handoff",
	]) {
		if (source.includes(legacyTerm)) {
			errors.push(`${relativePath} still references legacy orchestration: ${legacyTerm}`);
		}
	}
}
const readOnlyEvidenceCommand = "node scripts/issue_workflow_evidence.mjs";
if (
	!reviewerSource.includes(readOnlyEvidenceCommand) ||
	!reviewSkillSource.includes(readOnlyEvidenceCommand)
) {
	errors.push("Reviewer instructions do not share the read-only evidence command");
}
if (
	reviewerSource.includes("vp run workflow:evidence") ||
	reviewSkillSource.includes("vp run workflow:evidence")
) {
	errors.push("Reviewer instructions require Vite+ for read-only evidence");
}

const checkWorkflowEvidenceBehavior = (source) => {
	const failures = [];
	const temporaryRoot = mkdtempSync(join(tmpdir(), "oven-workflow-evidence-"));
	const repository = join(temporaryRoot, "repository");
	const scriptsDirectory = join(repository, "scripts");
	const scriptPath = join(scriptsDirectory, "issue_workflow_evidence.mjs");
	const trackedPath = join(repository, "tracked.txt");
	const renamedPath = join(repository, "renamed.txt");
	const renamedSecretPath = join(repository, "renamed-secret.txt");
	const kindPath = join(repository, "kind.txt");
	const guardedPath = join(repository, "guarded.txt");
	const guardedUntrackedPath = join(repository, "guarded-untracked.txt");
	const guardedLinkPath = join(repository, "guarded-link");
	const linkTargetA = join(temporaryRoot, "link-target-a.txt");
	const linkTargetB = join(temporaryRoot, "link-target-b.txt");
	const outsideSecretPath = join(temporaryRoot, "outside-secret.txt");
	const envPath = join(repository, ".env");
	const devVarsPath = join(repository, ".dev.vars");
	const devVarsEnvironmentPath = join(repository, ".dev.vars.production");

	const git = (args) => run("git", args, repository);
	const evidence = () => JSON.parse(run(process.execPath, [scriptPath], repository));

	try {
		mkdirSync(scriptsDirectory, { recursive: true });
		writeFileSync(scriptPath, source);
		git(["init"]);
		git(["branch", "-M", "main"]);
		git(["config", "user.name", "Workflow Evidence"]);
		git(["config", "user.email", "workflow-evidence@example.invalid"]);
		git(["config", "commit.gpgsign", "false"]);
		writeFileSync(trackedPath, "one\n");
		git(["add", "tracked.txt"]);
		git(["commit", "-m", "Initial evidence fixture"]);

		const baseline = evidence();
		git(["commit", "--allow-empty", "-m", "Advance evidence HEAD"]);
		const advancedHead = evidence();
		if (baseline.head === advancedHead.head) {
			failures.push("Evidence did not observe a changed HEAD");
		}
		if (baseline.contentFingerprint === advancedHead.contentFingerprint) {
			failures.push("contentFingerprint did not detect a changed HEAD");
		}

		writeFileSync(trackedPath, "two\n");
		const unstaged = evidence();
		git(["add", "tracked.txt"]);
		const staged = evidence();

		if (advancedHead.fingerprint === unstaged.fingerprint) {
			failures.push("fingerprint did not detect tracked content changes");
		}
		if (unstaged.fingerprint === staged.fingerprint) {
			failures.push("fingerprint did not distinguish staged and unstaged state");
		}
		if (advancedHead.contentFingerprint === unstaged.contentFingerprint) {
			failures.push("contentFingerprint did not detect tracked content changes");
		}
		if (unstaged.contentFingerprint !== staged.contentFingerprint) {
			failures.push("contentFingerprint changed from staging alone");
		}
		if (JSON.stringify(unstaged.statusEntries) === JSON.stringify(staged.statusEntries)) {
			failures.push("statusEntries did not preserve index state");
		}

		git(["commit", "-m", "Update evidence fixture"]);
		const clean = evidence();
		renameSync(trackedPath, renamedPath);
		const unstagedRename = evidence();
		git(["add", "--all"]);
		const stagedRename = evidence();
		if (clean.fingerprint === unstagedRename.fingerprint) {
			failures.push("fingerprint did not detect a rename");
		}
		if (clean.contentFingerprint === unstagedRename.contentFingerprint) {
			failures.push("contentFingerprint did not detect a rename");
		}
		if (unstagedRename.fingerprint === stagedRename.fingerprint) {
			failures.push("fingerprint did not distinguish staging a rename");
		}
		if (unstagedRename.contentFingerprint !== stagedRename.contentFingerprint) {
			failures.push("contentFingerprint changed from staging a rename");
		}
		if (JSON.stringify(unstagedRename.changedPaths) !== JSON.stringify(stagedRename.changedPaths)) {
			failures.push("changedPaths changed from staging a rename");
		}

		chmodSync(renamedPath, 0o755);
		const executable = evidence();
		if (stagedRename.contentFingerprint === executable.contentFingerprint) {
			failures.push("contentFingerprint did not detect executable-bit changes");
		}
		git(["add", "renamed.txt"]);
		const stagedExecutable = evidence();
		if (executable.contentFingerprint !== stagedExecutable.contentFingerprint) {
			failures.push("contentFingerprint changed from staging an executable bit");
		}

		git(["commit", "-m", "Rename executable fixture"]);
		const beforeDeletion = evidence();
		rmSync(renamedPath);
		const unstagedDeletion = evidence();
		git(["add", "--update"]);
		const stagedDeletion = evidence();
		if (beforeDeletion.contentFingerprint === unstagedDeletion.contentFingerprint) {
			failures.push("contentFingerprint did not detect deletion");
		}
		if (unstagedDeletion.contentFingerprint !== stagedDeletion.contentFingerprint) {
			failures.push("contentFingerprint changed from staging a deletion");
		}

		writeFileSync(join(repository, "untracked.txt"), "untracked\n");
		const untracked = evidence();
		if (stagedDeletion.fingerprint === untracked.fingerprint) {
			failures.push("fingerprint did not detect an untracked file");
		}
		if (stagedDeletion.contentFingerprint === untracked.contentFingerprint) {
			failures.push("contentFingerprint did not detect an untracked file");
		}
		git(["add", "untracked.txt"]);
		const stagedUntracked = evidence();
		if (untracked.fingerprint === stagedUntracked.fingerprint) {
			failures.push("fingerprint did not distinguish staging an untracked file");
		}
		if (untracked.contentFingerprint !== stagedUntracked.contentFingerprint) {
			failures.push("contentFingerprint changed from staging an untracked file");
		}

		writeFileSync(linkTargetA, "shared\n");
		writeFileSync(linkTargetB, "shared\n");
		writeFileSync(kindPath, "shared\n");
		const regularKind = evidence();
		rmSync(kindPath);
		symlinkSync(linkTargetA, kindPath);
		const symlinkKind = evidence();
		if (regularKind.contentFingerprint === symlinkKind.contentFingerprint) {
			failures.push("contentFingerprint did not distinguish a regular file and symlink");
		}
		git(["add", "kind.txt"]);
		const stagedSymlink = evidence();
		if (symlinkKind.contentFingerprint !== stagedSymlink.contentFingerprint) {
			failures.push("contentFingerprint changed from staging a symlink");
		}
		rmSync(kindPath);
		symlinkSync(linkTargetB, kindPath);
		const retargetedSymlink = evidence();
		if (stagedSymlink.contentFingerprint === retargetedSymlink.contentFingerprint) {
			failures.push("contentFingerprint did not detect a changed symlink target");
		}
		git(["add", "kind.txt"]);
		const stagedRetargetedSymlink = evidence();
		if (retargetedSymlink.contentFingerprint !== stagedRetargetedSymlink.contentFingerprint) {
			failures.push("contentFingerprint changed from staging a retargeted symlink");
		}

		git(["commit", "-m", "Add file-kind fixtures"]);
		writeFileSync(guardedPath, "base\n");
		git(["add", "guarded.txt"]);
		git(["commit", "-m", "Add guarded fixture"]);

		writeFileSync(outsideSecretPath, "EVIDENCE_MUST_NOT_READ\n", { mode: 0o000 });
		symlinkSync(outsideSecretPath, join(repository, "outside-link"));
		writeFileSync(envPath, "EVIDENCE_ENV_SECRET\n", { mode: 0o000 });
		writeFileSync(devVarsPath, "EVIDENCE_DEV_VARS_SECRET\n", { mode: 0o000 });
		writeFileSync(devVarsEnvironmentPath, "EVIDENCE_DEV_VARS_ENV_SECRET\n", { mode: 0o000 });
		const guarded = evidence();
		const serialized = JSON.stringify(guarded);
		for (const secretPath of [".env", ".dev.vars", ".dev.vars.production"]) {
			if (!guarded.unsafePaths.includes(secretPath)) {
				failures.push(`${secretPath} was not reported as unsafe`);
			}
		}
		if (
			serialized.includes("EVIDENCE_MUST_NOT_READ") ||
			serialized.includes("ENV_SECRET") ||
			serialized.includes("DEV_VARS_SECRET")
		) {
			failures.push("Evidence exposed secret content");
		}

		writeFileSync(guardedPath, "worktree-one\n");
		const guardedWorktreeOne = evidence();
		writeFileSync(guardedPath, "worktree-two\n");
		const guardedWorktreeTwo = evidence();
		if (
			guardedWorktreeOne.fingerprint !== guardedWorktreeTwo.fingerprint ||
			guardedWorktreeOne.contentFingerprint !== guardedWorktreeTwo.contentFingerprint
		) {
			failures.push("Evidence read worktree content while an unsafe path was present");
		}

		git(["add", "guarded.txt"]);
		const guardedIndexOne = evidence();
		writeFileSync(guardedPath, "index-two\n");
		git(["add", "guarded.txt"]);
		const guardedIndexTwo = evidence();
		if (
			guardedIndexOne.fingerprint !== guardedIndexTwo.fingerprint ||
			guardedIndexOne.contentFingerprint !== guardedIndexTwo.contentFingerprint
		) {
			failures.push("Evidence read index content while an unsafe path was present");
		}

		writeFileSync(guardedUntrackedPath, "untracked-one\n");
		const guardedUntrackedOne = evidence();
		writeFileSync(guardedUntrackedPath, "untracked-two\n");
		const guardedUntrackedTwo = evidence();
		if (
			guardedUntrackedOne.fingerprint !== guardedUntrackedTwo.fingerprint ||
			guardedUntrackedOne.contentFingerprint !== guardedUntrackedTwo.contentFingerprint
		) {
			failures.push("Evidence read untracked content while an unsafe path was present");
		}

		symlinkSync(linkTargetA, guardedLinkPath);
		const guardedLinkOne = evidence();
		rmSync(guardedLinkPath);
		symlinkSync(linkTargetB, guardedLinkPath);
		const guardedLinkTwo = evidence();
		if (
			guardedLinkOne.fingerprint !== guardedLinkTwo.fingerprint ||
			guardedLinkOne.contentFingerprint !== guardedLinkTwo.contentFingerprint
		) {
			failures.push("Evidence read symlink targets while an unsafe path was present");
		}

		chmodSync(envPath, 0o600);
		chmodSync(devVarsPath, 0o600);
		chmodSync(devVarsEnvironmentPath, 0o600);
		git(["add", "--all"]);
		git(["commit", "-m", "Add secret-path fixtures"]);
		renameSync(envPath, renamedSecretPath);
		git(["add", "--all"]);
		chmodSync(renamedSecretPath, 0o000);
		const renamedSecret = evidence();
		if (!renamedSecret.unsafePaths.includes(".env")) {
			failures.push("Evidence did not retain the secret rename source in unsafePaths");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failures.push(`Evidence behavior test failed to run: ${message}`);
	} finally {
		for (const guardedSecretPath of [outsideSecretPath, renamedSecretPath]) {
			try {
				chmodSync(guardedSecretPath, 0o600);
			} catch {
				continue;
			}
		}
		rmSync(temporaryRoot, { recursive: true, force: true });
	}

	return failures;
};

const checkReadOnlyEvidenceBehavior = (source) => {
	const failures = [];
	const temporaryRoot = mkdtempSync(join(tmpdir(), "oven-read-only-evidence-"));
	const repository = join(temporaryRoot, "repository");
	const scriptsDirectory = join(repository, "scripts");
	const scriptPath = join(scriptsDirectory, "issue_workflow_evidence.mjs");
	let readOnlyApplied = false;

	try {
		mkdirSync(scriptsDirectory, { recursive: true });
		writeFileSync(scriptPath, source);
		writeFileSync(join(repository, "tracked.txt"), "one\n");
		run("git", ["init"], repository);
		run("git", ["branch", "-M", "main"], repository);
		run("git", ["config", "user.name", "Read-only Evidence"], repository);
		run("git", ["config", "user.email", "read-only@example.invalid"], repository);
		run("git", ["config", "commit.gpgsign", "false"], repository);
		run("git", ["add", "scripts/issue_workflow_evidence.mjs", "tracked.txt"], repository);
		run("git", ["commit", "-m", "Initial read-only fixture"], repository);
		writeFileSync(join(repository, "tracked.txt"), "two\n");

		setTreeReadOnly(repository);
		readOnlyApplied = true;
		const before = snapshotTree(repository);
		const environment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
		delete environment.NODE_COMPILE_CACHE;
		const evidence = JSON.parse(
			execFileSync(process.execPath, [scriptPath], {
				cwd: repository,
				encoding: "utf8",
				env: environment,
				maxBuffer: 16 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		const after = snapshotTree(repository);
		if (!evidence.changedPaths.includes("tracked.txt")) {
			failures.push("Read-only evidence did not report the changed path");
		}
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			failures.push("Read-only evidence modified repository, index, or cache state");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failures.push(`Read-only evidence behavior test failed to run: ${message}`);
	} finally {
		if (readOnlyApplied && existsSync(repository)) setTreeWritable(repository);
		rmSync(temporaryRoot, { recursive: true, force: true });
	}

	return failures;
};

const checkIgnoredSecretBehavior = (source, gitignoreSource) => {
	const failures = [];
	const temporaryRoot = mkdtempSync(join(tmpdir(), "oven-ignored-secret-"));
	const repository = join(temporaryRoot, "repository");
	const scriptsDirectory = join(repository, "scripts");
	const secretsDirectory = join(repository, "secrets");
	const scriptPath = join(scriptsDirectory, "issue_workflow_evidence.mjs");
	const envPath = join(repository, ".env");
	const devVarsPath = join(repository, ".dev.vars.production");
	const secretPath = join(secretsDirectory, "token");
	const evidence = () => JSON.parse(run(process.execPath, [scriptPath], repository));
	const isIgnored = (relativePath) => {
		try {
			run("git", ["check-ignore", "--no-index", "--quiet", relativePath], repository);
			return true;
		} catch {
			return false;
		}
	};
	const replaceUnreadable = (targetPath, value) => {
		chmodSync(targetPath, 0o600);
		writeFileSync(targetPath, value);
		chmodSync(targetPath, 0o000);
	};

	try {
		mkdirSync(scriptsDirectory, { recursive: true });
		mkdirSync(secretsDirectory, { recursive: true });
		writeFileSync(scriptPath, source);
		writeFileSync(join(repository, ".gitignore"), gitignoreSource);
		writeFileSync(join(repository, "tracked.txt"), "one\n");
		run("git", ["init"], repository);
		run("git", ["branch", "-M", "main"], repository);
		run("git", ["config", "user.name", "Ignored Secret"], repository);
		run("git", ["config", "user.email", "ignored-secret@example.invalid"], repository);
		run("git", ["config", "commit.gpgsign", "false"], repository);
		run(
			"git",
			["add", ".gitignore", "scripts/issue_workflow_evidence.mjs", "tracked.txt"],
			repository,
		);
		run("git", ["commit", "-m", "Initial secret fixture"], repository);

		writeFileSync(envPath, "IGNORED_SECRET_ENV_A\n", { mode: 0o000 });
		writeFileSync(devVarsPath, "IGNORED_SECRET_DEV_A\n", { mode: 0o000 });
		writeFileSync(secretPath, "IGNORED_SECRET_DIR_A\n", { mode: 0o000 });
		for (const ignoredPath of [".env", ".dev.vars.production", "secrets/token"]) {
			if (!isIgnored(ignoredPath)) failures.push(`${ignoredPath} was not ignored`);
		}

		const baseline = evidence();
		if (baseline.unsafePaths.length > 0 || baseline.changedPaths.length > 0) {
			failures.push("Existing ignored secrets blocked a clean workflow");
		}
		if (JSON.stringify(baseline).includes("IGNORED_SECRET")) {
			failures.push("Evidence exposed ignored secret content");
		}

		let previous = baseline;
		for (const [targetPath, value] of [
			[envPath, "IGNORED_SECRET_ENV_B\n"],
			[devVarsPath, "IGNORED_SECRET_DEV_B\n"],
			[secretPath, "IGNORED_SECRET_DIR_B\n"],
		]) {
			replaceUnreadable(targetPath, value);
			const current = evidence();
			if (current.secretStateFingerprint === previous.secretStateFingerprint) {
				failures.push(`Ignored secret metadata change was not detected: ${targetPath}`);
			}
			if (current.contentFingerprint !== previous.contentFingerprint) {
				failures.push(`Ignored secret changed contentFingerprint: ${targetPath}`);
			}
			if (JSON.stringify(current).includes("IGNORED_SECRET")) {
				failures.push("Evidence used ignored secret content");
			}
			previous = current;
		}

		writeFileSync(join(repository, ".env.example"), "EXAMPLE_ENV\n");
		writeFileSync(join(repository, ".dev.vars.example"), "EXAMPLE_DEV_VARS\n");
		for (const examplePath of [".env.example", ".dev.vars.example"]) {
			if (isIgnored(examplePath)) failures.push(`${examplePath} was incorrectly ignored`);
		}
		const examples = evidence();
		for (const examplePath of [".env.example", ".dev.vars.example"]) {
			if (!examples.changedPaths.includes(examplePath)) {
				failures.push(`${examplePath} was not reported as an ordinary changed path`);
			}
			if (examples.unsafePaths.includes(examplePath)) {
				failures.push(`${examplePath} was incorrectly reported as unsafe`);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failures.push(`Ignored secret behavior test failed to run: ${message}`);
	} finally {
		for (const guardedSecretPath of [envPath, devVarsPath, secretPath]) {
			try {
				chmodSync(guardedSecretPath, 0o600);
			} catch {
				continue;
			}
		}
		rmSync(temporaryRoot, { recursive: true, force: true });
	}

	return failures;
};

const checkGateBehavior = () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "oven-workflow-safety-"));
	const repository = join(temporaryRoot, "repository");
	const remote = join(temporaryRoot, "remote.git");
	const scriptsDirectory = join(repository, "scripts");
	const evidenceSource = read("scripts/issue_workflow_evidence.mjs");
	const gateSource = read("scripts/issue_workflow_gate.mjs");
	const gatePath = join(scriptsDirectory, "issue_workflow_gate.mjs");
	const evidencePath = join(scriptsDirectory, "issue_workflow_evidence.mjs");
	const branch = "chore/20260905_workflow-test";

	const git = (args) => run("git", args, repository).trim();
	const evidence = () => JSON.parse(run(process.execPath, [evidencePath], repository));
	const gatePasses = (args) =>
		spawnSync(process.execPath, [gatePath, ...args], {
			cwd: repository,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
		}).status === 0;

	try {
		mkdirSync(repository);
		mkdirSync(scriptsDirectory);
		run("git", ["init", "--bare", remote], temporaryRoot);
		run("git", ["init", "-b", "main"], repository);
		git(["config", "user.name", "Workflow Safety"]);
		git(["config", "user.email", "workflow-safety@example.invalid"]);
		git(["config", "commit.gpgsign", "false"]);
		writeFileSync(
			join(repository, ".gitignore"),
			".env\n.env.*\n!.env.example\n.dev.vars*\n!.dev.vars.example\nsecrets/\n",
		);
		writeFileSync(join(repository, "README.md"), "# fixture\n");
		writeFileSync(evidencePath, evidenceSource);
		writeFileSync(gatePath, gateSource);
		git([
			"add",
			".gitignore",
			"README.md",
			"scripts/issue_workflow_evidence.mjs",
			"scripts/issue_workflow_gate.mjs",
		]);
		git(["commit", "-m", "Initial fixture"]);
		git(["remote", "add", "origin", remote]);
		git(["push", "-u", "origin", "main"]);

		const mainInitial = evidence();
		const mainArguments = [
			"--expected-branch",
			"main",
			"--baseline-base",
			mainInitial.baseHead,
			"--baseline-secret-state",
			mainInitial.secretStateFingerprint,
		];
		if (gatePasses(["start", ...mainArguments])) {
			errors.push("Start gate accepted main without --allow-main");
		}
		if (!gatePasses(["start", ...mainArguments, "--allow-main"])) {
			errors.push("Start gate rejected explicitly allowed main");
		}

		const invalidBranch = "workflow-invalid-branch";
		git(["switch", "-c", invalidBranch]);
		if (
			gatePasses([
				"start",
				"--expected-branch",
				invalidBranch,
				"--baseline-base",
				mainInitial.baseHead,
				"--baseline-secret-state",
				mainInitial.secretStateFingerprint,
			])
		) {
			errors.push("Start gate accepted an invalid branch name");
		}
		git(["switch", "main"]);
		git(["switch", "-c", branch]);

		const initial = evidence();
		const baseArguments = [
			"--expected-branch",
			branch,
			"--baseline-base",
			initial.baseHead,
			"--baseline-secret-state",
			initial.secretStateFingerprint,
		];
		if (!gatePasses(["start", ...baseArguments])) {
			errors.push("Start gate rejected a clean feature branch");
		}

		writeFileSync(join(repository, "workflow.txt"), "candidate\n");
		if (gatePasses(["start", ...baseArguments])) {
			errors.push("Start gate accepted an unapproved changed path");
		}
		if (!gatePasses(["start", ...baseArguments, "--allow-path", "workflow.txt"])) {
			errors.push("Start gate rejected an approved existing path");
		}

		git(["add", "workflow.txt"]);
		if (!gatePasses(["stage", ...baseArguments, "--allow-path", "workflow.txt"])) {
			errors.push("Stage gate rejected the exact staged path set");
		}
		writeFileSync(join(repository, "extra.txt"), "extra\n");
		if (gatePasses(["stage", ...baseArguments, "--allow-path", "workflow.txt"])) {
			errors.push("Stage gate accepted an extra unstaged path");
		}
		rmSync(join(repository, "extra.txt"));
		git(["commit", "-m", "Add workflow fixture"]);
		const finalCommit = git(["rev-parse", "HEAD"]);
		if (gatePasses(["publish", ...baseArguments])) {
			errors.push("Publish gate accepted an unapproved outgoing commit");
		}
		const publishArguments = ["publish", ...baseArguments, "--allow-commit", finalCommit];
		if (!gatePasses(publishArguments)) {
			errors.push("Publish gate rejected the exact outgoing commit sequence");
		}

		const beforeSecret = evidence();
		const secretMarker = "OVEN_WORKFLOW_SECRET_MARKER";
		writeFileSync(join(repository, ".env"), `${secretMarker}\n`);
		const afterSecret = evidence();
		if (afterSecret.secretStateFingerprint === beforeSecret.secretStateFingerprint) {
			errors.push("Evidence did not detect ignored secret metadata changes");
		}
		if (afterSecret.contentFingerprint !== beforeSecret.contentFingerprint) {
			errors.push("Ignored secret content changed the repository content fingerprint");
		}
		if (JSON.stringify(afterSecret).includes(secretMarker)) {
			errors.push("Evidence exposed ignored secret content");
		}
		if (gatePasses(publishArguments)) {
			errors.push("Publish gate accepted changed ignored secret metadata");
		}

		rmSync(join(repository, ".env"));
		if (evidence().secretStateFingerprint !== beforeSecret.secretStateFingerprint) {
			errors.push("Secret metadata fingerprint did not return to its original state");
		}
		if (!gatePasses(publishArguments)) {
			errors.push("Publish gate rejected the restored starting secret metadata baseline");
		}

		git(["push", "-u", "origin", "HEAD"]);
		git(["fetch", "origin", branch]);
		if (
			!gatePasses([
				"complete",
				"--expected-branch",
				branch,
				"--expected-head",
				finalCommit,
				"--baseline-secret-state",
				initial.secretStateFingerprint,
			])
		) {
			errors.push("Complete gate rejected the pushed clean branch");
		}

		git(["switch", "main"]);
		writeFileSync(join(repository, "README.md"), "# advanced fixture\n");
		git(["add", "README.md"]);
		git(["commit", "-m", "Advance main fixture"]);
		git(["push", "origin", "main"]);
		git(["switch", branch]);
		git(["fetch", "origin", "main"]);
		const diverged = evidence();
		if (
			gatePasses([
				"publish",
				"--expected-branch",
				branch,
				"--baseline-base",
				diverged.baseHead,
				"--baseline-secret-state",
				initial.secretStateFingerprint,
				"--allow-commit",
				finalCommit,
			])
		) {
			errors.push("Publish gate accepted a branch that does not contain current origin/main");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		errors.push(`Workflow gate behavior test failed to run: ${message}`);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
};

const evidenceSource = read("scripts/issue_workflow_evidence.mjs");
const gitignoreSource = read(".gitignore");
for (const failure of checkWorkflowEvidenceBehavior(evidenceSource)) {
	errors.push(`Workflow evidence: ${failure}`);
}
for (const failure of checkReadOnlyEvidenceBehavior(evidenceSource)) {
	errors.push(`Read-only evidence: ${failure}`);
}
for (const failure of checkIgnoredSecretBehavior(evidenceSource, gitignoreSource)) {
	errors.push(`Ignored secret evidence: ${failure}`);
}
checkGateBehavior();

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join("\n"));
	process.exit(1);
}

console.log("Agent catalog, workflow evidence, and Git safety gate behavior passed");
