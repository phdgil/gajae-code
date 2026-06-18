import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxProfileCommands,
	buildGjcTmuxSessionName,
	buildGjcTmuxUntaggedSessionError,
	GJC_TMUX_BRANCH_OPTION,
	GJC_TMUX_BRANCH_SLUG_OPTION,
	GJC_TMUX_PROFILE_OPTION,
	GJC_TMUX_PROFILE_VALUE,
	GJC_TMUX_PROJECT_OPTION,
	GJC_TMUX_SESSION_ID_OPTION,
	GJC_TMUX_SESSION_STATE_FILE_OPTION,
	normalizeTmuxCreatedAt,
	persistGjcTmuxOwnershipSidecar,
	readGjcTmuxOwnershipSidecar,
	removeGjcTmuxOwnershipSidecar,
	resolveGjcTmuxCommand,
} from "./tmux-common";

export interface GjcTmuxSessionStatus {
	name: string;
	attached: boolean;
	windows: number;
	panes: number;
	bindings: string;
	createdAt: string;
	branch?: string;
	branchSlug?: string;
	project?: string;
	sessionId?: string;
	sessionStateFile?: string;
	panePids: number[];
	profile?: string;
}

export interface GjcTmuxSessionTagsForGc {
	profile?: string;
	project?: string;
	branch?: string;
	branchSlug?: string;
	sessionId?: string;
	sessionStateFile?: string;
	createdAt?: string;
	attached?: boolean;
	panePids?: number[];
}

export interface GjcTmuxSessionsForGc {
	tagged: GjcTmuxSessionStatus[];
	untagged: GjcTmuxSessionStatus[];
}

function runTmux(args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const result = Bun.spawnSync([tmuxCommand, ...args], { stdout: "pipe", stderr: "pipe", env });
	if (result.exitCode === 0) return result.stdout.toString();
	throw new Error(result.stderr.toString().trim() || `tmux ${args.join(" ")} failed`);
}

function tryKillSession(sessionName: string, env: NodeJS.ProcessEnv): void {
	try {
		runTmux(["kill-session", "-t", `=${sessionName}`], env);
	} catch {
		// Best-effort cleanup only; preserve the original create/tag failure.
	}
	removeGjcTmuxOwnershipSidecar(sessionName, env);
}

function parseBooleanFlag(value: string | undefined): boolean {
	return value === "1";
}

function parseNumber(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "0", 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseSessionLine(line: string, env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus | null {
	const [
		name = "",
		windows = "0",
		attached = "0",
		created = "",
		profile = "",
		bindings = "",
		panes = "0",
		panePids = "",
		branch = "",
		branchSlug = "",
		project = "",
		sessionId = "",
		sessionStateFile = "",
	] = line.split("\t");
	if (!name) return null;
	const createdAt = normalizeTmuxCreatedAt(created);
	const ownershipSidecar = readGjcTmuxOwnershipSidecar(name, env);
	const sidecarMatches = ownershipSidecar && (!ownershipSidecar.createdAt || ownershipSidecar.createdAt === createdAt);
	if (profile !== GJC_TMUX_PROFILE_VALUE && !sidecarMatches) return null;
	return {
		name,
		attached: parseBooleanFlag(attached),
		windows: parseNumber(windows),
		panes: parseNumber(panes),
		panePids: panePids
			.split(",")
			.map(pid => parseNumber(pid))
			.filter(pid => pid > 0),
		bindings,
		createdAt,
		branch: branch || ownershipSidecar?.branch || undefined,
		branchSlug: branchSlug || ownershipSidecar?.branchSlug || undefined,
		project: project || ownershipSidecar?.project || undefined,
		profile: profile || (sidecarMatches ? GJC_TMUX_PROFILE_VALUE : undefined),
		sessionId: sessionId || ownershipSidecar?.sessionId || undefined,
		sessionStateFile: sessionStateFile || ownershipSidecar?.sessionStateFile || undefined,
	};
}

function runListSessions(format: string, env: NodeJS.ProcessEnv = process.env): string[] {
	let output = "";
	try {
		output = runTmux(["list-sessions", "-F", format], env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("no server running") || message.includes("failed to connect to server")) return [];
		throw error;
	}
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function listSessionLines(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions(
		`#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{${GJC_TMUX_PROFILE_OPTION}}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{${GJC_TMUX_BRANCH_OPTION}}\t#{${GJC_TMUX_BRANCH_SLUG_OPTION}}\t#{${GJC_TMUX_PROJECT_OPTION}}\t#{${GJC_TMUX_SESSION_ID_OPTION}}\t#{${GJC_TMUX_SESSION_STATE_FILE_OPTION}}`,
		env,
	);
}

function listRawTmuxSessionNames(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions("#{session_name}", env).map(line => line.split("\t")[0] ?? line);
}

export function listGjcTmuxSessions(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus[] {
	return listSessionLines(env)
		.map(line => parseSessionLine(line, env))
		.filter((session): session is GjcTmuxSessionStatus => session != null)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal */
export function listTmuxSessionsForGc(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionsForGc {
	const sessions = listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is GjcTmuxSessionStatus => session != null);
	const tagged = sessions
		.filter(session => session.profile === GJC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
	const taggedNames = new Set(tagged.map(session => session.name));
	const byName = new Map(sessions.map(session => [session.name, session]));
	const untagged = listRawTmuxSessionNames(env)
		.filter(name => !taggedNames.has(name))
		.map(
			name =>
				byName.get(name) ?? {
					name,
					attached: false,
					windows: 0,
					panes: 0,
					panePids: [],
					bindings: "",
					createdAt: "",
				},
		)
		.sort((a, b) => a.name.localeCompare(b.name));
	return { tagged, untagged };
}

export function findGjcTmuxSessionByBranch(
	branch: string,
	env: NodeJS.ProcessEnv = process.env,
	project?: string | null,
): GjcTmuxSessionStatus | undefined {
	return listGjcTmuxSessions(env).find(
		session => session.branch === branch && (!project || session.project === project),
	);
}

export function statusGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus {
	const session = listGjcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	if (session) return session;
	if (listRawTmuxSessionNames(env).includes(sessionName)) {
		throw new Error(buildGjcTmuxUntaggedSessionError(sessionName, resolveGjcTmuxCommand(env)));
	}
	throw new Error(`gjc_tmux_session_not_found:${sessionName}`);
}

export function createGjcTmuxSession(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus {
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const sessionName = buildGjcTmuxSessionName(env);
	const command = "exec env GJC_TMUX_LAUNCHED=1 gjc";
	const created = Bun.spawnSync([tmuxCommand, "new-session", "-d", "-s", sessionName, command], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	if (created.exitCode !== 0) throw new Error(created.stderr.toString().trim() || "gjc_tmux_session_create_failed");
	persistGjcTmuxOwnershipSidecar({ sessionName, tmuxCommand }, env);
	try {
		for (const profileCommand of buildGjcTmuxProfileCommands(sessionName, env)) {
			runTmux(profileCommand.args, env);
		}
	} catch (error) {
		if (!readGjcTmuxOwnershipSidecar(sessionName, env)) {
			tryKillSession(sessionName, env);
			throw error;
		}
	}
	const session = statusGjcTmuxSession(sessionName, env);
	persistGjcTmuxOwnershipSidecar(
		{
			sessionName,
			createdAt: session.createdAt,
			branch: session.branch,
			branchSlug: session.branchSlug,
			project: session.project,
			tmuxCommand,
		},
		env,
	);
	return session;
}

function readExactOptionForGc(sessionName: string, option: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		return (
			runTmux(["show-options", "-qv", "-t", buildGjcTmuxExactOptionTarget(sessionName), option], env).trim() ||
			undefined
		);
	} catch {
		return undefined;
	}
}

/** @internal */
export function readTmuxSessionTagsForGc(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionTagsForGc {
	const ownershipSidecar = readGjcTmuxOwnershipSidecar(sessionName, env);
	const session = listGjcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	return {
		profile: readExactOptionForGc(sessionName, GJC_TMUX_PROFILE_OPTION, env) ?? (ownershipSidecar ? GJC_TMUX_PROFILE_VALUE : undefined),
		project: readExactOptionForGc(sessionName, GJC_TMUX_PROJECT_OPTION, env) ?? ownershipSidecar?.project,
		branch: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_OPTION, env) ?? ownershipSidecar?.branch,
		branchSlug: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_SLUG_OPTION, env) ?? ownershipSidecar?.branchSlug,
		sessionId: readExactOptionForGc(sessionName, GJC_TMUX_SESSION_ID_OPTION, env) ?? ownershipSidecar?.sessionId,
		sessionStateFile:
			readExactOptionForGc(sessionName, GJC_TMUX_SESSION_STATE_FILE_OPTION, env) ?? ownershipSidecar?.sessionStateFile,
		createdAt: session?.createdAt,
		attached: session?.attached,
		panePids: session?.panePids,
	};
}

export function removeGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus {
	const session = statusGjcTmuxSession(sessionName, env);
	const sidecar = readGjcTmuxOwnershipSidecar(session.name, env);
	if (session.attached || session.panePids.length > 0) {
		throw new Error(`gjc_tmux_session_live:${sessionName}`);
	}
	if ((readExactOptionForGc(session.name, GJC_TMUX_PROFILE_OPTION, env) ?? "") !== GJC_TMUX_PROFILE_VALUE && !sidecar) {
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	}
	runTmux(["kill-session", "-t", `=${session.name}`], env);
	removeGjcTmuxOwnershipSidecar(session.name, env);
	return session;
}

export function attachGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): never {
	const session = statusGjcTmuxSession(sessionName, env);
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const result = Bun.spawnSync([tmuxCommand, "attach-session", "-t", `=${session.name}`], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env,
	});
	process.exit(result.exitCode ?? 1);
}
