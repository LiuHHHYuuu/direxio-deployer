import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FetchLike } from "../types.js";
import type { AgentMemoryItem } from "./thread-memory.js";

const VECTOR_FILE_SCHEMA = "direxio.agent_memory_vectors.v1";
const LOCAL_VECTOR_PROFILE = "local-hash-v1";
const LOCAL_VECTOR_DIMENSIONS = 128;

export interface ThreadMemorySearchInput {
  query: string;
  limit?: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  event?: Record<string, unknown>;
}

export interface FileBackedMemoryVectorIndexOptions {
  dataDir: string;
  filePath?: string;
  now?: () => Date;
}

interface MemoryVectorRecord {
  memoryId: string;
  conversationId?: string;
  textHash: string;
  profile: string;
  dimensions: number;
  vector: number[];
  updatedAt: string;
}

interface MemoryVectorDocument {
  schema: typeof VECTOR_FILE_SCHEMA;
  items: MemoryVectorRecord[];
}

interface EmbeddingProfile {
  profile: string;
  dimensions?: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Function: Maintains a local vector index for persistent Agent memories.
 * Inputs:
 * - dataDir: Product-agent data directory.
 * - filePath: Optional test override for the vector JSON path.
 * Output:
 * - Searchable memory records ranked by cosine similarity.
 * Side effects:
 * - Reads and writes `$dataDir/memory/vectors.json`.
 * Errors:
 * - Embedding provider errors fall back to local hash vectors so chat still works.
 */
export class FileBackedMemoryVectorIndex {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: FileBackedMemoryVectorIndexOptions) {
    this.filePath = options.filePath || join(options.dataDir, "memory", "vectors.json");
    this.now = options.now || (() => new Date());
  }

  async search(
    conversationId: string,
    query: string,
    memories: AgentMemoryItem[],
    input: Omit<ThreadMemorySearchInput, "query">
  ): Promise<AgentMemoryItem[]> {
    return searchMemoryItems({
      conversationId,
      query,
      memories,
      limit: input.limit,
      fetchImpl: input.fetchImpl,
      env: input.env,
      event: input.event,
      readVectors: () => this.readDocument(),
      writeVectors: (document) => this.writeDocument(document),
      now: this.now
    });
  }

  private readDocument(): MemoryVectorDocument {
    if (!existsSync(this.filePath)) {
      return { schema: VECTOR_FILE_SCHEMA, items: [] };
    }
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    const items = Array.isArray(record.items)
      ? record.items.map(normalizeVectorRecord).filter((item): item is MemoryVectorRecord => Boolean(item))
      : [];
    return { schema: VECTOR_FILE_SCHEMA, items };
  }

  private writeDocument(document: MemoryVectorDocument): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify({
      schema: VECTOR_FILE_SCHEMA,
      items: document.items
    }, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

export async function searchMemoryItems(input: {
  conversationId: string;
  query: string;
  memories: AgentMemoryItem[];
  limit?: number;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  event?: Record<string, unknown>;
  readVectors?: () => MemoryVectorDocument;
  writeVectors?: (document: MemoryVectorDocument) => void;
  now?: () => Date;
}): Promise<AgentMemoryItem[]> {
  const query = input.query.trim();
  const memories = input.memories.filter((item) => item.text.trim());
  if (!query || memories.length === 0) return [];

  const limit = boundedLimit(input.limit, 5);
  const profile = embeddingProfileForSearch(input) || localEmbeddingProfile();
  const document = input.readVectors?.() || { schema: VECTOR_FILE_SCHEMA, items: [] };
  const now = input.now || (() => new Date());
  const { queryVector, changed } = await ensureVectors({
    document,
    conversationId: input.conversationId,
    query,
    memories,
    profile,
    now
  });
  if (changed) input.writeVectors?.(document);

  const byMemoryId = new Map(memories.map((item) => [item.id, item]));
  return document.items
    .filter((item) =>
      item.profile === profile.profile &&
      item.dimensions === queryVector.length &&
      (!item.conversationId || item.conversationId === input.conversationId) &&
      byMemoryId.has(item.memoryId)
    )
    .map((item) => ({
      memory: byMemoryId.get(item.memoryId)!,
      score: cosineSimilarity(queryVector, item.vector)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);
}

async function ensureVectors(input: {
  document: MemoryVectorDocument;
  conversationId: string;
  query: string;
  memories: AgentMemoryItem[];
  profile: EmbeddingProfile;
  now: () => Date;
}): Promise<{ queryVector: number[]; changed: boolean }> {
  const wanted = input.memories.filter((memory) => needsVector(input.document, input.conversationId, memory, input.profile.profile));
  const texts = [input.query, ...wanted.map((item) => item.text)];
  let vectors = await input.profile.embed(texts).catch(() => localEmbeddingProfile().embed(texts));
  if (vectors.length !== texts.length || vectors.some((vector) => vector.length === 0)) {
    vectors = await localEmbeddingProfile().embed(texts);
  }
  const queryVector = normalizeVector(vectors[0] || []);
  let changed = false;
  wanted.forEach((memory, index) => {
    const vector = normalizeVector(vectors[index + 1] || []);
    if (vector.length === 0) return;
    upsertVector(input.document.items, {
      memoryId: memory.id,
      conversationId: input.conversationId,
      textHash: textHash(memory.text),
      profile: vector.length === queryVector.length ? input.profile.profile : LOCAL_VECTOR_PROFILE,
      dimensions: vector.length,
      vector,
      updatedAt: input.now().toISOString()
    });
    changed = true;
  });
  return { queryVector, changed };
}

function needsVector(document: MemoryVectorDocument, conversationId: string, memory: AgentMemoryItem, profile: string): boolean {
  return !document.items.some((item) =>
    item.memoryId === memory.id &&
    item.profile === profile &&
    item.textHash === textHash(memory.text) &&
    (!item.conversationId || item.conversationId === conversationId) &&
    item.vector.length === item.dimensions
  );
}

function upsertVector(items: MemoryVectorRecord[], next: MemoryVectorRecord): void {
  const index = items.findIndex((item) => item.memoryId === next.memoryId && item.profile === next.profile);
  if (index >= 0) {
    items[index] = next;
    return;
  }
  items.push(next);
}

function embeddingProfileForSearch(input: {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  event?: Record<string, unknown>;
}): EmbeddingProfile | null {
  const fetchImpl = input.fetchImpl;
  if (!fetchImpl) return null;
  const env = input.env || process.env;
  const eventProfile = embeddingConfigFromEvent(input.event);
  const baseUrl = eventProfile.baseUrl || env.DIREXIO_AGENT_EMBEDDING_BASE_URL || "";
  const apiKey = eventProfile.apiKey || env.DIREXIO_AGENT_EMBEDDING_API_KEY || "";
  const model = eventProfile.model || env.DIREXIO_AGENT_EMBEDDING_MODEL || "";
  if (!baseUrl.trim() || !model.trim()) return null;
  const endpoint = embeddingEndpoint(baseUrl);
  const profile = `embedding:${endpoint}:${model.trim()}`;
  return {
    profile,
    async embed(texts: string[]) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {})
        },
        body: JSON.stringify({ model: model.trim(), input: texts })
      });
      if (!response.ok) throw new Error(`embedding request failed: ${response.status}`);
      const body = await response.json() as unknown;
      const data = asArray(asRecord(body).data);
      return data.map((item) => numberList(asRecord(item).embedding));
    }
  };
}

function embeddingConfigFromEvent(event?: Record<string, unknown>): { baseUrl: string; apiKey: string; model: string } {
  const agentConfig = asRecord(event?.agent_config);
  const profile = firstRecord(
    agentConfig.embedding_profile,
    asRecord(agentConfig.knowledge).embedding_profile,
    asRecord(agentConfig.knowledge).embeddingProfile
  );
  return {
    baseUrl: stringField(profile.base_url) || stringField(profile.baseUrl),
    apiKey: stringField(profile.api_key) || stringField(profile.apiKey),
    model: stringField(profile.model)
  };
}

function embeddingEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/embeddings")) return trimmed;
  if (trimmed.endsWith("/chat/completions")) return `${trimmed.slice(0, -"/chat/completions".length)}/embeddings`;
  return `${trimmed}/embeddings`;
}

function localEmbeddingProfile(): EmbeddingProfile {
  return {
    profile: LOCAL_VECTOR_PROFILE,
    async embed(texts: string[]) {
      return texts.map((text) => localHashVector(text));
    }
  };
}

function localHashVector(text: string): number[] {
  const vector = Array.from({ length: LOCAL_VECTOR_DIMENSIONS }, () => 0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/gu) || [];
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const index = (digest[0] || 0) % LOCAL_VECTOR_DIMENSIONS;
    vector[index] = (vector[index] || 0) + 1;
  }
  return normalizeVector(vector);
}

function normalizeVector(vector: number[]): number[] {
  const values = vector.filter((item) => Number.isFinite(item));
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return [];
  return values.map((value) => value / norm);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] || 0) * (right[index] || 0);
  }
  return score;
}

function normalizeVectorRecord(value: unknown): MemoryVectorRecord | null {
  const record = asRecord(value);
  const memoryId = stringField(record.memoryId);
  const textHashValue = stringField(record.textHash);
  const profile = stringField(record.profile);
  const dimensions = numberField(record.dimensions);
  const vector = numberList(record.vector);
  const updatedAt = stringField(record.updatedAt);
  if (!memoryId || !textHashValue || !profile || dimensions <= 0 || vector.length !== dimensions || !updatedAt) {
    return null;
  }
  return {
    memoryId,
    conversationId: stringField(record.conversationId),
    textHash: textHashValue,
    profile,
    dimensions,
    vector,
    updatedAt
  };
}

function boundedLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(20, Math.floor(value)))
    : fallback;
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}
