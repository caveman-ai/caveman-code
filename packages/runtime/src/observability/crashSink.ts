// Where the runtime's failures go once crash reports start (CrashReports.ts sets it). Its own module, with no
// dependencies, so what reports a failure never loads the crash reporter: it loads only where it starts.

type Sink = (error: unknown, mechanism: string, fatal: boolean) => void;

let sink: Sink | undefined;

export const setCrashSink = (next: Sink | undefined): void => {
  sink = next;
};

/** Reports one failure (`fatal` when it ends the process); nowhere until crash reports start, and when they never do. */
export const reportCrash = (error: unknown, mechanism: string, fatal = false): void =>
  sink?.(error, mechanism, fatal);
