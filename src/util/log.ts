import pino, { type Logger } from "pino";

export function createLogger(level = "info", destination?: pino.DestinationStream): Logger {
	return pino({ level, base: { app: "rp-relay" }, timestamp: pino.stdTimeFunctions.isoTime }, destination);
}
