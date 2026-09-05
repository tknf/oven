import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (path) => readFileSync(resolve(root, path), "utf8");

const expectedAgents = ["researcher.toml", "reviewer.toml", "worker.toml"];
const actualAgents = readdirSync(resolve(root, ".codex/agents"))
	.filter((path) => path.endsWith(".toml"))
	.sort();
if (JSON.stringify(actualAgents) !== JSON.stringify(expectedAgents)) {
	errors.push(`Unexpected agent catalog: ${actualAgents.join(", ")}`);
}

for (const file of expectedAgents) {
	const source = read(`.codex/agents/${file}`);
	const name = file.slice(0, -".toml".length);
	if (!source.includes(`name = "${name}"`)) errors.push(`${file} has the wrong name`);
	const sandbox = file === "worker.toml" ? "workspace-write" : "read-only";
	if (!source.includes(`sandbox_mode = "${sandbox}"`)) {
		errors.push(`${file} must use ${sandbox}`);
	}
}

const expectedSkills = ["impl", "issue", "plan", "release"];
const actualSkills = readdirSync(resolve(root, ".agents/skills"))
	.filter((name) => existsSync(resolve(root, ".agents/skills", name, "SKILL.md")))
	.sort();
if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
	errors.push(`Unexpected skill catalog: ${actualSkills.join(", ")}`);
}

for (const name of expectedSkills) {
	const source = read(`.agents/skills/${name}/SKILL.md`);
	if (!source.startsWith(`---\nname: ${name}\n`)) {
		errors.push(`${name}/SKILL.md has invalid frontmatter`);
	}
}

const forbiddenPaths = [
	".codex/agents/auditor.toml",
	".codex/agents/planner.toml",
	".codex/agents/implementer.toml",
	".codex/agents/integrator.toml",
	".codex/agents/release_manager.toml",
	".agents/skills/issue-slop-check/SKILL.md",
	".agents/skills/review/SKILL.md",
	".agents/skills/wrapup/SKILL.md",
	".agents/skills/issue/references/git-safety.md",
	"scripts/issue_workflow_evidence.mjs",
	"scripts/issue_workflow_gate.mjs",
];
for (const path of forbiddenPaths) {
	if (existsSync(resolve(root, path))) errors.push(`Obsolete workflow file remains: ${path}`);
}

const issueSource = read(".agents/skills/issue/SKILL.md");
for (const command of ["Use `$plan`", "Use `$impl`", "Use `$wrapup`"]) {
	if (issueSource.includes(command)) errors.push(`$issue still orchestrates a phase: ${command}`);
}

const isIgnored = (path) => {
	try {
		execFileSync("git", ["check-ignore", "--no-index", "--quiet", path], {
			cwd: root,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
};
for (const path of [".env", ".dev.vars", "secrets/example"]) {
	if (!isIgnored(path)) errors.push(`Secret path is not ignored: ${path}`);
}
for (const path of [".env.example", ".dev.vars.example"]) {
	if (isIgnored(path)) errors.push(`Example environment file is ignored: ${path}`);
}

if (errors.length > 0) {
	console.error(errors.map((error) => `- ${error}`).join("\n"));
	process.exit(1);
}

console.log("Minimal agent, skill, and secret-path structure passed");
