import { Type } from "@sinclair/typebox";
import { Id, OptNullable } from "./common.js";

export const HostHello = Type.Object({
	machineId: Id,
	hostname: Type.String(),
	roots: Type.Array(Type.String()),
	backends: Type.Object({
		herdr: OptNullable(Type.String()),
		tmux: OptNullable(Type.String()),
		wt: Type.Optional(Type.Boolean()),
		console: Type.Optional(Type.Boolean()),
	}),
	defaultBackend: Type.Optional(Type.String()),
	launchers: Type.Array(Type.String()),
	defaultLauncher: Type.Optional(Type.String()),
});

export const HostListDirs = Type.Object({ machineId: Id, path: Type.String() });
export const HostDirs = Type.Object({ path: Type.String(), dirs: Type.Array(Type.String()) });
export const HostHerdrLayout = Type.Object({ machineId: Id });
const Pane = Type.Object({ id: Type.String(), agent: Type.Optional(Type.String()) });
const Tab = Type.Object({ id: Type.String(), label: Type.String(), panes: Type.Array(Pane) });
export const HostHerdrLayoutResult = Type.Object({
	workspaces: Type.Array(
		Type.Object({ id: Type.String(), label: Type.String(), cwd: OptNullable(Type.String()), tabs: Type.Array(Tab) }),
	),
});
export const HerdrTarget = Type.Union([
	Type.Object({ type: Type.Literal("workspace") }),
	Type.Object({ type: Type.Literal("tab"), workspaceId: Type.String() }),
	Type.Object({
		type: Type.Literal("split"),
		paneId: Type.String(),
		direction: Type.Union([Type.Literal("right"), Type.Literal("down")]),
	}),
]);
export const HostSpawn = Type.Object({
	machineId: Id,
	cwd: Type.String(),
	name: Type.Optional(Type.String()),
	launcher: Type.Optional(Type.String()),
	backend: Type.Optional(
		Type.Union([Type.Literal("herdr"), Type.Literal("tmux"), Type.Literal("wt"), Type.Literal("console")]),
	),
	herdrTarget: Type.Optional(HerdrTarget),
	initialPrompt: Type.Optional(Type.String()),
});
export const HostSpawned = Type.Object({
	spawnId: Id,
	backend: Type.String(),
	herdr: OptNullable(Type.Object({ workspaceId: Type.String(), paneId: Type.String() })),
	tmuxSession: OptNullable(Type.String()),
});
export const HostKill = Type.Object({ machineId: Id, spawnId: Id });
export const HostsUpdate = Type.Object({
	upsert: Type.Array(
		Type.Object({ machineId: Id, hostname: Type.String(), roots: Type.Array(Type.String()), online: Type.Boolean() }),
	),
	remove: Type.Array(Id),
});
