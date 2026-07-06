export function numberFromEnv({
  env,
  key,
  fallback,
  min,
  max
}: {
  env: NodeJS.ProcessEnv;
  key: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  const value = Number(env[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function flagFromEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === "1" || env[key] === "true";
}
