import { spawn } from "node:child_process";

/** Notificación a systemd (`Type=notify`): se delega en `systemd-notify` porque Node no habla sockets datagrama Unix. */
export function sdNotify(...assignments: string[]): void {
	if (!process.env.NOTIFY_SOCKET) return;
	try {
		const p = spawn("systemd-notify", assignments, { stdio: "ignore" });
		p.on("error", () => {});
		p.unref();
	} catch {
		// sin systemd-notify: ignorar
	}
}

/** Intervalo del watchdog: la mitad de `WATCHDOG_USEC` si existe; 10 s por defecto (PLAN-RELAY §8). */
export function watchdogIntervalMs(env: NodeJS.ProcessEnv = process.env): number | null {
	if (!env.NOTIFY_SOCKET) return null;
	const usec = Number(env.WATCHDOG_USEC);
	if (Number.isFinite(usec) && usec > 0) return Math.max(1000, Math.floor(usec / 2000));
	return 10_000;
}
