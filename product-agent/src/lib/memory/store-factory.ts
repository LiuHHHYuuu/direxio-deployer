import {
  DEFAULT_COMPRESSION_CHUNK_MESSAGES,
  DEFAULT_CONTEXT_WINDOW_MESSAGES,
  InMemoryThreadMemoryStore,
  type ThreadMemoryStore
} from "./thread-memory.js";
import { FileBackedThreadMemoryStore } from "./file-thread-memory.js";

/**
 * Function: Chooses the default thread memory store for product-agent runtime startup.
 * Inputs:
 * - env: Environment variables from the current service process.
 * Output:
 * - File-backed memory when `DIREXIO_AGENT_DATA_DIR` is set, otherwise in-memory.
 * Side effects:
 * - None during construction beyond creating the store object; file writes happen on memory commands.
 * Errors:
 * - Empty `DIREXIO_AGENT_DATA_DIR` falls back to in-memory behavior.
 */
export function createDefaultThreadMemoryStore(env: NodeJS.ProcessEnv = process.env): ThreadMemoryStore {
  const dataDir = env.DIREXIO_AGENT_DATA_DIR?.trim();
  const maxMessages = numberFromEnv(env, "DIREXIO_AGENT_CONTEXT_WINDOW_MESSAGES", DEFAULT_CONTEXT_WINDOW_MESSAGES, 2, 500);
  const compressionChunkMessages = numberFromEnv(
    env,
    "DIREXIO_AGENT_COMPRESSION_CHUNK_MESSAGES",
    DEFAULT_COMPRESSION_CHUNK_MESSAGES,
    2,
    Math.max(2, maxMessages)
  );
  const autoCompact = env.DIREXIO_AGENT_AUTO_COMPACT_MEMORY?.trim() !== "0";
  if (!dataDir) {
    return new InMemoryThreadMemoryStore(maxMessages, {
      compressionChunkMessages,
      autoCompact
    });
  }
  return new FileBackedThreadMemoryStore({
    dataDir,
    ownerId: env.DIREXIO_AGENT_MEMORY_OWNER_ID?.trim() || "self-hosted-node",
    maxMessages,
    compressionChunkMessages,
    autoCompact
  });
}

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
