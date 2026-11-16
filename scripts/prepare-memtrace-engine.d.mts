import type { MemcodeEngineBundle } from '../runtime/managed-engine';
export function validateEnginePin(value: unknown, platform: string, arch: string): MemcodeEngineBundle;
export function verifyEngineArchive(archive: Uint8Array, bundle: MemcodeEngineBundle): Map<string, Buffer>;
export function prepareMemtraceEngine(options?: { root?: string; platform?: string; arch?: string; catalog?: { bundles: Record<string, unknown> }; fetch?: typeof fetch }): Promise<{output: string; platform: string; arch: string; engineVersion: string; id: string; archiveSha256: string; archiveBytes: number; verifiedFiles: number}>;
