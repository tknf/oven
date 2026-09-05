import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceScript = resolve(root, "scripts/issue_workflow_evidence.mjs");
const modes = ["start", "stage", "publish", "complete"];

const failUsage = (message) => {
	console.error(message);
	console.error(
		"usage: workflow:gate <start|stage|publish|complete> --expected-branch <branch> --baseline-secret-state <hash> [--baseline-base <hash>] [--expected-head <hash>] [--allow-main] [--allow-commit <hash>] [--allow-path <path>]",
	);
	process.exit(2);
};

const parseArguments = () => {
	const [mode, ...args] = process.argv.slice(2);
	if (!mode || !modes.includes(mode)) failUsage("Invalid gate mode");

	const options = {
		mode,
		expectedBranch: null,
		baselineBase: null,
		baselineSecretState: null,
		expectedHead: null,
		allowMain: false,
		allowedCommits: [],
		allowedPaths: [],
	};

	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (option === "--allow-main") {
			options.allowMain = true;
			continue;
		}

		const value = args[index + 1];
		if (!option || !value) failUsage(`${option ?? "argument"} requires a value`);
		index += 1;

		if (option === "--expected-branch") options.expectedBranch = value;
		else if (option === "--baseline-base") options.baselineBase = value;
		else if (option === "--baseline-secret-state") options.baselineSecretState = value;
		else if (option === "--expected-head") options.expectedHead = value;
		else if (option === "--allow-commit") options.allowedCommits.push(value);
		else if (option === "--allow-path") options.allowedPaths.push(value);
		else failUsage(`Unknown argument: ${option}`);
	}

	if (!options.expectedBranch) failUsage(`${mode} requires --expected-branch`);
	if (!options.baselineSecretState) failUsage(`${mode} requires --baseline-secret-state`);
	if (mode === "complete") {
		if (!options.expectedHead) failUsage("complete requires --expected-head");
	} else if (!options.baselineBase) {
		failUsage(`${mode} requires --baseline-base`);
	}
	if (mode === "stage" && options.allowedPaths.length === 0) {
		failUsage("stage requires at least one --allow-path");
	}

	return options;
};

const sameOrderedValues = (actual, expected) =>
	actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const sameSortedValues = (actual, expected) => {
	const sortedExpected = [...new Set(expected)].sort((a, b) => a.localeCompare(b));
	return sameOrderedValues(actual, sortedExpected);
};

const branchPattern =
	/^(feat|fix|docs|refactor|test|chore|ci|release)\/(issue-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*|[0-9]{8}_[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const evidence = JSON.parse(
	execFileSync(process.execPath, [evidenceScript], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	}),
);
const options = parseArguments();
const errors = [];

if (evidence.branch !== options.expectedBranch) {
	errors.push(`Branch changed: ${evidence.branch || "(detached)"}`);
}
if (evidence.branch === "main" && !options.allowMain) {
	errors.push("Direct work on main was not explicitly allowed");
} else if (evidence.branch !== "main" && !branchPattern.test(evidence.branch)) {
	errors.push(`Branch name does not follow the repository rule: ${evidence.branch}`);
}
if (evidence.unsafePaths.length > 0) {
	errors.push(`Secret paths changed: ${evidence.unsafePaths.join(", ")}`);
}
if (evidence.secretStateFingerprint !== options.baselineSecretState) {
	errors.push("Ignored secret metadata changed after the workflow started");
}

if (options.mode === "complete") {
	if (evidence.head !== options.expectedHead) {
		errors.push(`HEAD does not match the final commit: ${evidence.head}`);
	}
	if (evidence.remoteBranchHead !== options.expectedHead) {
		errors.push(
			`Remote branch does not match the final commit: ${evidence.remoteBranchHead ?? "(missing)"}`,
		);
	}
	if (evidence.changedPaths.length > 0) {
		errors.push(`Working tree is not clean after push: ${evidence.changedPaths.join(", ")}`);
	}
} else {
	if (evidence.baseRef !== "origin/main" || evidence.baseHead !== options.baselineBase) {
		errors.push(
			`origin/main changed from the workflow baseline: ${evidence.baseHead ?? "(missing)"}`,
		);
	}
	if (!evidence.baseIsAncestor) {
		errors.push("Current origin/main is not an ancestor of HEAD");
	}
	if (!sameOrderedValues(evidence.outgoingCommits, options.allowedCommits)) {
		errors.push("Outgoing commit sequence does not match the allowlist");
	}

	if (options.mode === "start") {
		if (evidence.stagedPaths.length > 0) {
			errors.push(`Index is not empty at workflow start: ${evidence.stagedPaths.join(", ")}`);
		}
		if (!sameSortedValues(evidence.changedPaths, options.allowedPaths)) {
			errors.push("Starting changed paths do not match the allowlist");
		}
	} else if (options.mode === "stage") {
		if (!sameSortedValues(evidence.stagedPaths, options.allowedPaths)) {
			errors.push("Staged paths do not match the allowlist");
		}
		if (!sameSortedValues(evidence.changedPaths, options.allowedPaths)) {
			errors.push("Total changed paths do not match the allowlist");
		}
		if (evidence.unstagedPaths.length > 0) {
			errors.push(`Unstaged changes remain: ${evidence.unstagedPaths.join(", ")}`);
		}
	} else if (evidence.changedPaths.length > 0) {
		errors.push(`Working tree is not clean after commit: ${evidence.changedPaths.join(", ")}`);
	}
}

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join("\n"));
	process.exit(1);
}

console.log(JSON.stringify({ gate: options.mode, status: "passed", repository: evidence }));
