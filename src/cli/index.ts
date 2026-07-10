#!/usr/bin/env node
/**
 * Entry point of the `oven` CLI. This is a scaffolding tool that only runs on a developer's
 * machine and is never imported from `@tknf/oven` itself (the runtime core), so it may use
 * `node:fs`/`node:path`/`node:process` directly (the backend-agnostic principle applies only
 * to the runtime core). It does not use an external CLI framework (e.g. commander) and parses
 * argv by hand.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import type { GenerateType, ModelDialect } from "./generate.js";
import { GENERATE_TYPES, planGeneration } from "./generate.js";

const USAGE = `Usage:
  oven generate <type> <Name> [--dir <path>] [--dialect sqlite|pg|mysql] [--force]
  oven g <type> <Name> ...        # alias for generate

  <type>: ${GENERATE_TYPES.join(" | ")}

Options:
  --dir <path>       Output directory (defaults to the conventional directory for <type>)
  --dialect <name>   model only (error for every other type). sqlite | pg | mysql (default: sqlite)
  --force            Overwrite an existing file

  oven --help         Show this help
  oven --version       Show the version`;

/** Reads package.json (as seen from dist/cli/index.js) and returns its version field. */
const readVersion = (): string => {
	const require = createRequire(import.meta.url);
	const pkg = require("../../package.json") as { version: string };
	return pkg.version;
};

/** Reads the value of a `--flag value` style argument. Returns `undefined` if not present. */
const readOption = (args: string[], flag: string): string | undefined => {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	return args[index + 1];
};

/** Checks whether `args` contains any `--` argument that is not one of the known flags. */
const findUnknownFlag = (args: string[], known: string[]): string | undefined => {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg?.startsWith("--")) continue;
		if (!known.includes(arg)) return arg;
		if (arg !== "--force") i += 1;
	}
	return undefined;
};

const isGenerateType = (value: string): value is GenerateType =>
	(GENERATE_TYPES as readonly string[]).includes(value);

const isModelDialect = (value: string): value is ModelDialect =>
	value === "sqlite" || value === "pg" || value === "mysql";

/** Runs the `oven generate`/`oven g` subcommand. */
const runGenerate = (args: string[]): void => {
	const known = ["--dir", "--dialect", "--force"];
	const unknownFlag = findUnknownFlag(args, known);
	if (unknownFlag) {
		console.error(`Unknown option: ${unknownFlag}\n\n${USAGE}`);
		process.exit(1);
	}

	const positionals = args.filter((arg, index) => {
		if (arg.startsWith("--")) return false;
		const prev = args[index - 1];
		return !(prev === "--dir" || prev === "--dialect");
	});
	const [type, name] = positionals;

	if (!type || !name) {
		console.error(`Please specify a type and a Name.\n\n${USAGE}`);
		process.exit(1);
	}
	if (!isGenerateType(type)) {
		console.error(`Unknown type: ${type}\n\n${USAGE}`);
		process.exit(1);
	}

	const dir = readOption(args, "--dir");
	const dialectInput = readOption(args, "--dialect");
	if (dialectInput !== undefined && type !== "model") {
		console.error(`--dialect only applies to the model template, not "${type}"\n\n${USAGE}`);
		process.exit(1);
	}
	if (dialectInput !== undefined && !isModelDialect(dialectInput)) {
		console.error(`Unknown dialect: ${dialectInput} (must be one of sqlite | pg | mysql)`);
		process.exit(1);
	}
	const force = args.includes("--force");

	const plan = planGeneration({
		type,
		name,
		dir,
		dialect: dialectInput,
	});

	if (existsSync(plan.filePath) && !force) {
		console.error(`File already exists: ${plan.filePath} (use --force to overwrite)`);
		process.exit(1);
	}

	mkdirSync(dirname(plan.filePath), { recursive: true });
	writeFileSync(plan.filePath, plan.content);
	console.log(`Generated: ${plan.filePath}`);
};

/** Main entry point of the CLI. Parses argv and dispatches to a subcommand. */
const main = (): void => {
	const [, , command, ...rest] = process.argv;

	if (command === "--version" || command === "-v") {
		console.log(readVersion());
		return;
	}
	if (!command || command === "--help" || command === "-h") {
		console.log(USAGE);
		return;
	}
	if (command === "generate" || command === "g") {
		if (rest[0] === "--help" || rest[0] === "-h") {
			console.log(USAGE);
			return;
		}
		runGenerate(rest);
		return;
	}

	console.error(`Unknown command: ${command}\n\n${USAGE}`);
	process.exit(1);
};

main();
