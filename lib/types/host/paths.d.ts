/**
 * Encode an arbitrary string as a single safe path segment (same algorithm as
 * DSH's persistence layer): safe code units stay literal, every other unit
 * (including `~`) becomes `~XXXX`; `.`/`..` are escaped to prevent traversal.
 */
export declare function encodeSegment(raw: string): string;
/**
 * Build the readable directory key for a project path (same algorithm as
 * DSH's persistence layer). Separators and drive separators become `-`;
 * unsafe code units use the `~XXXX` escape; result is wrapped in `--…--`.
 */
export declare function projectKey(cwd: string): string;
/**
 * Resolve the DSH home directory: `$DSH_HOME` first, then `~/.dsh`
 * (mirrors `@deepseek-ai/dsh-home-paths`'s `resolveDshHome`).
 */
export declare function resolveDshHome(env?: Record<string, string | undefined>): string;
/** Directory where session log files live. */
export declare function sessionsRoot(home: string): string;
/** Directory where per-session projection caches live. */
export declare function projectionCacheRoot(home: string): string;
