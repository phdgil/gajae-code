import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildGjcTmuxExactOptionTarget,
	persistGjcTmuxOwnershipSidecar,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-common";
import {
	listGjcTmuxSessions,
	removeGjcTmuxSession,
	statusGjcTmuxSession,
} from "@gajae-code/coding-agent/gjc-runtime/tmux-sessions";

type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;
type SpawnSyncSpy = { mockImplementation(implementation: (command: string[]) => SpawnSyncResult): void };

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

describe("GJC tmux session management", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		const ownershipRoot = path.join(os.tmpdir(), "gjc-tmux-session-tests");
		await fs.rm(ownershipRoot, { recursive: true, force: true });
	});

	it("lists only GJC-managed tmux sessions", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				[
					"gajae_code_abc\t1\t0\t1770000000\t1\troot\t2\t12345\tfeature/demo\tfeature-demo\t/repo-a",
					"unrelated\t2\t1\t1770000060\t\troot\t3\t23456\t\t",
					"gajae_code\t1\t1\t1770000120\t\troot\t1\t34567\t\t",
				].join("\n"),
			),
		);

		const sessions = listGjcTmuxSessions({ GJC_TMUX_COMMAND: "tmux-test" });

		expect(sessions.map(session => session.name)).toEqual(["gajae_code_abc"]);
		expect(sessions[0].attached).toBe(false);
		expect(sessions[0].panes).toBe(2);
		expect(sessions[0].panePids).toEqual([12345]);
		expect(sessions[0].bindings).toBe("root");
		expect(sessions[0].createdAt).toBe("2026-02-02T02:40:00.000Z");
		expect(sessions[0].branch).toBe("feature/demo");
		expect(sessions[0].project).toBe("/repo-a");
		expect(Bun.spawnSync).toHaveBeenCalledWith(
			[
				"tmux-test",
				"list-sessions",
				"-F",
				"#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{@gjc-profile}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{@gjc-branch}\t#{@gjc-branch-slug}\t#{@gjc-project}\t#{@gjc-session-id}\t#{@gjc-session-state-file}",
			],
			expect.any(Object),
		);
	});

	it("returns an empty list when tmux has no server", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(1, "", "no server running on /tmp/tmux"));

		expect(listGjcTmuxSessions()).toEqual([]);
	});

	it("guards status and remove to GJC-managed sessions", () => {
		const env = { GJC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "gajae_code_work\t1\t0\t1770000000\t1\troot\t1\t\t\t\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		expect(statusGjcTmuxSession("gajae_code_work", env).name).toBe("gajae_code_work");
		expect(() => statusGjcTmuxSession("unrelated", env)).toThrow("gjc_tmux_session_not_found:unrelated");
		expect(removeGjcTmuxSession("gajae_code_work", env).name).toBe("gajae_code_work");
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=gajae_code_work"]);
	});

	it("does not kill when final live profile check fails", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "gajae_code_work\t1\t0\t1770000000\t1\troot\t1\t\t\t\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "\n");
			return spawnResult(0, "");
		});

		expect(() => removeGjcTmuxSession("gajae_code_work")).toThrow("gjc_tmux_session_not_managed:gajae_code_work");
		expect(calls.some(call => call.includes("kill-session"))).toBe(false);
	});

	it("diagnoses sessions the multiplexer lists but did not tag with the GJC profile", () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				// The bare `#{session_name}` probe sees the session (psmux ls shows it)...
				if (format === "#{session_name}") return spawnResult(0, "psmux_session\n");
				// ...but the full format does not round-trip @gjc-profile, so the profile column is empty.
				return spawnResult(0, "psmux_session\t1\t0\t1770000000\t\troot\t0\t\t\t\t\n");
			}
			return spawnResult(0, "");
		});

		expect(() => statusGjcTmuxSession("psmux_session", { GJC_TMUX_COMMAND: "psmux" })).toThrow(
			"gjc_tmux_session_untagged:psmux_session",
		);
		expect(() => statusGjcTmuxSession("psmux_session", { GJC_TMUX_COMMAND: "psmux" })).toThrow(/ownership sidecar/);
	});

	it("recovers a managed session from the ownership sidecar when user options do not round-trip", () => {
		const env = { GJC_TMUX_COMMAND: "psmux", GJC_TMUX_OWNERSHIP_ROOT: path.join(os.tmpdir(), "gjc-tmux-session-tests") };
		persistGjcTmuxOwnershipSidecar(
			{
				sessionName: "psmux_session",
				project: "/repo-a",
				branch: "feature/demo",
				branchSlug: "feature-demo",
			},
			env,
		);
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "psmux_session\n");
				return spawnResult(0, "psmux_session\t1\t0\t1770000000\t\troot\t0\t\t\t\n");
			}
			return spawnResult(0, "");
		});

		const session = statusGjcTmuxSession("psmux_session", env);
		expect(session.name).toBe("psmux_session");
		expect(session.project).toBe("/repo-a");
		expect(session.branch).toBe("feature/demo");
		expect(listGjcTmuxSessions(env).map(candidate => candidate.name)).toEqual(["psmux_session"]);
	});

	it("still reports plain not-found when the multiplexer does not list the session", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(0, ""));

		expect(() => statusGjcTmuxSession("ghost")).toThrow("gjc_tmux_session_not_found:ghost");
	});

	it("builds a window-qualified exact target for tmux option commands", () => {
		// tmux 3.6a only resolves the exact session for option commands when the
		// target is window-qualified (`=NAME:`); a bare `=NAME` does not (#580).
		expect(buildGjcTmuxExactOptionTarget("gajae_code_work")).toBe("=gajae_code_work:");
	});

	it("queries the profile option with a window-qualified exact target", () => {
		const env = { GJC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "gajae_code_work\t1\t0\t1770000000\t1\troot\t1\t\t\t\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		removeGjcTmuxSession("gajae_code_work", env);

		const showOptions = calls.find(call => call.includes("show-options"));
		expect(showOptions).toEqual(["tmux", "show-options", "-qv", "-t", "=gajae_code_work:", "@gjc-profile"]);
		// Session-scoped commands keep the bare exact target, which tmux resolves.
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=gajae_code_work"]);
	});
});
