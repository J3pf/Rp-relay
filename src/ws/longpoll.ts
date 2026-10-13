import type { Envelope } from "@j3pf/rp-protocol";
import type { AgentConn } from "./conn.js";

/** Adaptador long-poll: implementa `AgentConn` con una cola que `poll` vacía (PROTOCOLO §7). */
export class LongPollConn implements AgentConn {
	readonly transport = "longpoll" as const;
	agentId: string | null = null;
	instance: string | null = null;
	epoch: string | null = null;
	lastSeq = 0;
	lastActivity = Date.now();
	closed: { code: number; reason: string } | null = null;
	private queue: Envelope[] = [];
	private bytes = 0;
	private waiter: (() => void) | null = null;

	constructor(readonly machineId: string) {}

	send(env: Envelope): boolean {
		if (this.closed) return false;
		this.queue.push(env);
		this.bytes += JSON.stringify(env).length;
		this.wake();
		return true;
	}
	close(code: number, reason = ""): void {
		if (this.closed) return;
		this.closed = { code, reason };
		this.wake();
	}
	get bufferedAmount(): number {
		return this.bytes;
	}
	touch(): void {
		this.lastActivity = Date.now();
	}
	private wake(): void {
		const w = this.waiter;
		this.waiter = null;
		w?.();
	}

	/** Espera hasta `timeoutMs` por mensajes. Devuelve `closed` si la conexión fue cerrada (p. ej. reemplazada). */
	async poll(
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ messages: Envelope[] } | { closed: { code: number; reason: string } }> {
		this.touch();
		if (this.queue.length === 0 && !this.closed) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, timeoutMs);
				const done = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", done);
					resolve();
				};
				this.waiter = done;
				signal?.addEventListener("abort", done, { once: true });
			});
			this.waiter = null;
		}
		this.touch();
		if (this.queue.length > 0) {
			const messages = this.queue;
			this.queue = [];
			this.bytes = 0;
			return { messages };
		}
		if (this.closed) return { closed: this.closed };
		return { messages: [] };
	}
}
