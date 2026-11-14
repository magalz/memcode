export interface NativeHost {
  call<T = unknown>(method: string, input?: unknown): Promise<T>;
}
export type Emit = (event: string, payload: unknown) => void;
