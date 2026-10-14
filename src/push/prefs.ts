import { NOTIFY_CATEGORIES, type NotifyCategory, type NotifyPrefs } from "@j3pf/rp-protocol";

export type QuietHours = { from: string; to: string; tz?: string };

const DEFAULTS: Record<NotifyCategory, boolean> = {
	permission: true,
	question: true,
	settled: true,
	error: true,
	terminal_wait: true,
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
	let fmt = dtfCache.get(tz);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: tz,
		});
		dtfCache.set(tz, fmt);
	}
	return fmt;
}

function minutesOfDay(date: Date, tz?: string): number {
	let hh = date.getUTCHours();
	let mm = date.getUTCMinutes();
	if (tz) {
		try {
			const parts = getFormatter(tz).formatToParts(date);
			hh = Number(parts.find((p) => p.type === "hour")?.value ?? hh);
			mm = Number(parts.find((p) => p.type === "minute")?.value ?? mm);
		} catch {
			// zona horaria inválida → UTC
		}
	}
	return (hh % 24) * 60 + mm;
}

const toMin = (s: string): number => {
	const [h, m] = s.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
};

export function inQuietHours(q: QuietHours | null | undefined, at: number): boolean {
	if (!q) return false;
	const t = minutesOfDay(new Date(at), q.tz);
	const from = toMin(q.from);
	const to = toMin(q.to);
	if (from === to) return false;
	return from < to ? t >= from && t < to : t >= from || t < to;
}

export interface NotifyDecisionInput {
	prefs: NotifyPrefs;
	machineId: string;
	machineQuiet: QuietHours | null;
	category: NotifyCategory;
	danger?: "low" | "medium" | "high";
	now: number;
}

/**
 * Decide si un dispositivo debe recibir la notificación (PLAN-RELAY §5.5): `prefs.machines[id]` sobrescribe a
 * `prefs.categories`; PC silenciada u horas silenciosas → no; salvo `danger=high` con `criticalAlways`.
 */
export function shouldNotify(i: NotifyDecisionInput): boolean {
	const mp = i.prefs.machines?.[i.machineId];
	const critical = i.category === "permission" && i.danger === "high" && i.prefs.criticalAlways === true;
	if (critical) return true;
	if (mp?.mute) return false;
	const enabled = mp?.categories?.[i.category] ?? i.prefs.categories?.[i.category] ?? DEFAULTS[i.category];
	if (!enabled) return false;
	const quiet = mp && "quietHours" in mp ? (mp.quietHours ?? null) : i.machineQuiet;
	if (inQuietHours(quiet, i.now)) return false;
	return true;
}

export function parsePrefs(json: string): NotifyPrefs {
	try {
		const v = JSON.parse(json);
		return v && typeof v === "object" ? (v as NotifyPrefs) : {};
	} catch {
		return {};
	}
}

export const isCategory = (s: string): s is NotifyCategory => (NOTIFY_CATEGORIES as readonly string[]).includes(s);
