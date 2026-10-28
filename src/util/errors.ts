import { ErrorCode, type ErrorCodeValue } from "@j3pf/rp-protocol";

export class RelayError extends Error {
	constructor(
		public readonly code: ErrorCodeValue,
		message: string,
		public readonly reason?: string,
	) {
		super(message);
	}
}

export const httpStatus = (code: string): number => {
	switch (code) {
		case ErrorCode.BadRequest:
			return 400;
		case ErrorCode.Unauthorized:
			return 401;
		case ErrorCode.NotFound:
			return 404;
		case ErrorCode.Conflict:
		case ErrorCode.AgentCloseUnsupported:
			return 409;
		case ErrorCode.AgentOffline:
		case ErrorCode.HostOffline:
			return 409;
		case ErrorCode.AgentTimeout:
		case ErrorCode.Timeout:
			return 504;
		case ErrorCode.TooLarge:
			return 413;
		case ErrorCode.RateLimited:
			return 429;
		default:
			return 500;
	}
};
