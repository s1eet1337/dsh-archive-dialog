/**
 * Structural service faces this plugin reads from the host Cordis context.
 *
 * Deliberately minimal (mirroring the convention used by ecosystem plugins):
 * only the members this plugin touches are declared, so the package builds
 * without importing `@deepseek-ai/cordis` type packages. The real runtime
 * objects satisfy these faces structurally.
 */
export {};
