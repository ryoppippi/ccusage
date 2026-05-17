/**
 * @fileoverview Remote Claude log fetch type definitions.
 *
 * Phase 1 only handles read-only fetch of `~/.claude/projects/` from
 * Unix-like remote hosts over SSH (Tailscale SSH is a transport). Credential
 * stores such as `~/.claude/.credentials.json` are intentionally never
 * transferred — see `REMOTE_TAR_TARGET` in `./ssh.ts`.
 */

export type RemoteHostSpec = {
	raw: string;
	user?: string;
	host: string;
	label: string;
};

export type RemoteFetchFailure = {
	host: string;
	reason: string;
};

export type RemoteFetchSuccess = {
	spec: RemoteHostSpec;
	rootPath: string;
};

export type MaterializedRemoteClaudeRoots = {
	rootPaths: string[];
	successes: RemoteFetchSuccess[];
	failures: RemoteFetchFailure[];
	dispose: () => Promise<void>;
};

export type RemoteOptions = {
	hosts: string[];
	useTailscale: boolean;
	tmpRoot?: string;
};
