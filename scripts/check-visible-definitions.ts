#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

const expected = ["deep-interview", "ralplan", "team", "ultragoal"];
const repoRoot = process.cwd();

function listDirs(dir: string): string[] {
	const full = path.join(repoRoot, dir);
	if (!fs.existsSync(full)) return [];
	return fs
		.readdirSync(full, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && fs.existsSync(path.join(full, entry.name, "SKILL.md")))
		.map(entry => entry.name);
}

function listFiles(dir: string, extension: string): string[] {
	const full = path.join(repoRoot, dir);
	if (!fs.existsSync(full)) return [];
	return fs
		.readdirSync(full, { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith(extension))
		.map(entry => entry.name.slice(0, -extension.length));
}

const visible = [
	...listDirs(".omp/skills"),
	...listDirs(".codex/skills"),
	...listDirs(".codex/agents"),
	...listFiles(".omp/commands", ".md"),
	...listFiles(".codex/commands", ".md"),
].sort();

const unexpected = visible.filter(name => !expected.includes(name));
const missing = expected.filter(name => !visible.includes(name));

if (unexpected.length > 0 || missing.length > 0 || visible.length !== expected.length) {
	console.error("Visible definitions mismatch");
	console.error(JSON.stringify({ expected, visible, missing, unexpected }, null, 2));
	process.exit(1);
}

console.log(`Visible definitions OK: ${visible.join(", ")}`);
