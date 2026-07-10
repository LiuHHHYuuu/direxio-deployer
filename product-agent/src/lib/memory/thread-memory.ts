import type { GatewayMessage } from "../types.js";
import type { ThreadMemorySearchInput } from "./vector-memory.js";
import { containsCredentialLikeSecret, redactCredentialLikeSecrets } from "./memory-safety.js";

export const DEFAULT_CONTEXT_WINDOW_MESSAGES = 30;
export const DEFAULT_COMPRESSION_CHUNK_MESSAGES = 12;

export type AgentMemoryItemType = "preference" | "fact" | "card_memory" | "skill_result" | "thread_summary";

export type AgentMemoryItemSource = "user_explicit" | "agent_card_save" | "prompt_skill" | "migration" | "auto_compression" | "automatic_extraction";

export type AgentMemoryScope = "owner" | "conversation";

export type AgentMemorySensitivity = "low" | "sensitive" | "secret";

export interface AgentMemoryItem {
  id: string;
  ownerId: string;
  conversationId?: string;
  type: AgentMemoryItemType;
  text: string;
  tags: string[];
  source: AgentMemoryItemSource;
  key?: string;
  scope?: AgentMemoryScope;
  confidence?: number;
  importance?: number;
  sensitivity?: AgentMemorySensitivity;
  evidence?: string;
  lastUsedAt?: string;
  useCount?: number;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ThreadMemorySnapshot {
  preferences: Record<string, string>;
  recentMessages: GatewayMessage[];
  persistentMemories: AgentMemoryItem[];
  relevantMemories?: AgentMemoryItem[];
}

export interface ThreadMemoryStore {
  rememberMessages(conversationId: string, messages: GatewayMessage[]): void;
  rememberAssistantReply(conversationId: string, reply: string): void;
  snapshot(conversationId: string): ThreadMemorySnapshot;
  listMemories(conversationId: string): AgentMemoryItem[];
  searchMemories(conversationId: string, input: ThreadMemorySearchInput): Promise<AgentMemoryItem[]>;
  saveMemory(conversationId: string, input: SaveAgentMemoryInput): AgentMemoryItem;
  deleteMemory(conversationId: string, id: string): boolean;
}

export interface SaveAgentMemoryInput {
  id?: string;
  type?: AgentMemoryItemType;
  text: string;
  tags?: string[];
  source?: AgentMemoryItemSource;
  key?: string;
  scope?: AgentMemoryScope;
  confidence?: number;
  importance?: number;
  sensitivity?: AgentMemorySensitivity;
  evidence?: string;
}

interface ThreadMemoryState {
  preferences: Record<string, string>;
  recentMessages: GatewayMessage[];
  persistentMemories: AgentMemoryItem[];
}

export interface InMemoryThreadMemoryStoreOptions {
  compressionChunkMessages?: number;
  autoCompact?: boolean;
  trimWhenOverLimit?: boolean;
  ownerId?: string;
  now?: () => Date;
}

export class InMemoryThreadMemoryStore implements ThreadMemoryStore {
  private readonly threads = new Map<string, ThreadMemoryState>();
  private readonly ownerMemories: AgentMemoryItem[] = [];
  private readonly compressionChunkMessages: number;
  private readonly autoCompact: boolean;
  private readonly trimWhenOverLimit: boolean;
  private readonly ownerId: string;
  private readonly now: () => Date;

  constructor(
    private readonly maxMessages = DEFAULT_CONTEXT_WINDOW_MESSAGES,
    options: InMemoryThreadMemoryStoreOptions = {}
  ) {
    this.compressionChunkMessages = boundedInteger(
      options.compressionChunkMessages,
      DEFAULT_COMPRESSION_CHUNK_MESSAGES,
      2,
      Math.max(2, this.maxMessages)
    );
    this.autoCompact = options.autoCompact ?? true;
    this.trimWhenOverLimit = options.trimWhenOverLimit ?? true;
    this.ownerId = options.ownerId || "in-memory";
    this.now = options.now || (() => new Date());
  }

  rememberMessages(conversationId: string, messages: GatewayMessage[]): void {
    const state = this.stateFor(conversationId);
    for (const message of messages) {
      state.recentMessages.push(message);
      rememberExplicitMemoryFromMessage({
        state,
        conversationId,
        message,
        ownerId: this.ownerId,
        now: this.now().toISOString()
      });
    }
    this.compactOrTrim(conversationId);
  }

  rememberAssistantReply(conversationId: string, reply: string): void {
    if (!reply.trim()) return;
    const state = this.stateFor(conversationId);
    state.recentMessages.push({ role: "assistant", content: reply.trim() });
    this.compactOrTrim(conversationId);
  }

  snapshot(conversationId: string): ThreadMemorySnapshot {
    const state = this.stateFor(conversationId);
    const persistentMemories = this.visibleMemories(conversationId);
    return {
      preferences: {
        ...preferencesFromMemoryItems(persistentMemories),
        ...state.preferences
      },
      recentMessages: [...state.recentMessages],
      persistentMemories
    };
  }

  listMemories(conversationId: string): AgentMemoryItem[] {
    return this.visibleMemories(conversationId);
  }

  async searchMemories(conversationId: string, input: ThreadMemorySearchInput): Promise<AgentMemoryItem[]> {
    return lexicalMemorySearch(this.listMemories(conversationId), input.query, input.limit);
  }

  saveMemory(conversationId: string, input: SaveAgentMemoryInput): AgentMemoryItem {
    const state = this.stateFor(conversationId);
    const now = new Date().toISOString();
    const itemInput = memoryItemInputForSave({
      conversationId,
      input,
      ownerId: "in-memory",
      now
    });
    const items = input.scope === "owner" ? this.ownerMemories : state.persistentMemories;
    upsertMemoryItem(items, itemInput);
    if (itemInput.type === "preference" && input.scope !== "owner") {
      Object.assign(state.preferences, preferencesFromMemoryItems(this.visibleMemories(conversationId)));
    }
    return memoryItemById(items, itemInput.id);
  }

  deleteMemory(conversationId: string, id: string): boolean {
    const state = this.stateFor(conversationId);
    const now = this.now().toISOString();
    const deleted = softDeleteMemoryItem(state.persistentMemories, id, now) ||
      softDeleteMemoryItem(this.ownerMemories, id, now);
    if (deleted) {
      state.preferences = preferencesFromMemoryItems(state.persistentMemories);
    }
    return deleted;
  }

  private visibleMemories(conversationId: string): AgentMemoryItem[] {
    return activeMemories([
      ...this.ownerMemories,
      ...this.stateFor(conversationId).persistentMemories
    ]);
  }

  compactRecentMessages(conversationId: string, options: { persist?: boolean; ownerId?: string } = {}): AgentMemoryItem[] {
    const state = this.stateFor(conversationId);
    const summaries = compactRecentMessagesToMemoryInputs({
      messages: state.recentMessages,
      conversationId,
      ownerId: options.ownerId || this.ownerId,
      now: this.now().toISOString(),
      maxMessages: this.maxMessages,
      chunkMessages: this.compressionChunkMessages
    });
    if (options.persist !== false) {
      for (const summary of summaries) {
        upsertMemoryItem(state.persistentMemories, summary);
      }
    }
    return summaries.map((summary) => memoryItemFromInput(summary));
  }

  trimRecentMessages(conversationId: string): void {
    trimMessages(this.stateFor(conversationId).recentMessages, this.maxMessages);
  }

  private compactOrTrim(conversationId: string): void {
    if (this.autoCompact) {
      this.compactRecentMessages(conversationId);
      return;
    }
    if (this.trimWhenOverLimit) {
      this.trimRecentMessages(conversationId);
    }
  }

  private stateFor(conversationId: string): ThreadMemoryState {
    const existing = this.threads.get(conversationId);
    if (existing) return existing;
    const created: ThreadMemoryState = {
      preferences: {},
      recentMessages: [],
      persistentMemories: []
    };
    this.threads.set(conversationId, created);
    return created;
  }
}

export function withRelevantMemories(
  snapshot: ThreadMemorySnapshot,
  relevantMemories: AgentMemoryItem[]
): ThreadMemorySnapshot {
  return {
    ...snapshot,
    relevantMemories: dedupeMemoryItems(relevantMemories)
  };
}

export function latestUserMessageContent(messages: GatewayMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() || "";
}

function lexicalMemorySearch(items: AgentMemoryItem[], query: string, limit = 5): AgentMemoryItem[] {
  const queryTokens = searchTokens(query);
  if (queryTokens.length === 0) return [];
  return items
    .map((item) => ({
      item,
      score: searchTokens(item.text).filter((token) => queryTokens.includes(token)).length
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
    .map((item) => item.item);
}

function searchTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/gu) || [])];
}

function dedupeMemoryItems(items: AgentMemoryItem[]): AgentMemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function compactRecentMessagesToMemoryInputs(options: {
  messages: GatewayMessage[];
  conversationId: string;
  ownerId: string;
  now: string;
  maxMessages: number;
  chunkMessages: number;
}): UpsertMemoryItemInput[] {
  const maxMessages = boundedInteger(options.maxMessages, DEFAULT_CONTEXT_WINDOW_MESSAGES, 2, 500);
  const chunkMessages = boundedInteger(options.chunkMessages, DEFAULT_COMPRESSION_CHUNK_MESSAGES, 2, maxMessages);
  const summaries: UpsertMemoryItemInput[] = [];
  while (options.messages.length > maxMessages) {
    const chunk = options.messages.splice(0, Math.min(chunkMessages, options.messages.length));
    const text = summarizeMessageChunk(chunk);
    if (!text) continue;
    summaries.push({
      id: threadSummaryMemoryId(options.conversationId, chunk, summaries.length),
      ownerId: options.ownerId,
      conversationId: options.conversationId,
      type: "thread_summary",
      text,
      tags: ["auto_summary", "thread_context"],
      source: "auto_compression",
      now: options.now
    });
  }
  return summaries;
}

function summarizeMessageChunk(messages: GatewayMessage[]): string {
  const lines = messages
    .map((message) => `${message.role}: ${singleLine(message.content)}`)
    .filter((line) => line.length > 0)
    .slice(0, 8);
  if (lines.length === 0) return "";
  return truncateMemoryText(redactCredentialLikeSecrets(
    `Compressed earlier thread context:\n${lines.map((line) => `- ${truncateLine(line, 120)}`).join("\n")}`
  ));
}

function threadSummaryMemoryId(conversationId: string, messages: GatewayMessage[], offset: number): string {
  const body = messages.map((message) => `${message.role}\u0000${message.content}`).join("\u0001");
  return `thread_summary:${encodeIdPart(conversationId)}:${encodeIdPart(body.toLowerCase().slice(0, 220))}:${offset}`;
}

function memoryItemFromInput(input: UpsertMemoryItemInput): AgentMemoryItem {
  return {
    id: input.id,
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    type: input.type,
    text: input.text,
    tags: [...input.tags],
    source: input.source,
    createdAt: input.now,
    updatedAt: input.now
  };
}

export interface ExplicitMemoryExtraction {
  preferences: Record<string, string>;
  factText: string;
}

/**
 * Function: Extracts user-approved memories from a single chat message.
 * Inputs:
 * - message: Normalized gateway message from the current AI conversation.
 * Output:
 * - Preference key/value pairs and one optional fact string.
 * Side effects:
 * - None; this is a pure parser used by in-memory and file-backed stores.
 * Errors:
 * - Malformed or non-user messages return an empty extraction.
 */
export function extractExplicitMemoryFromMessage(message: GatewayMessage): ExplicitMemoryExtraction {
  if (message.role !== "user") {
    return { preferences: {}, factText: "" };
  }
  const content = message.content.trim();
  if (containsCredentialLikeSecret(content)) {
    return { preferences: {}, factText: "" };
  }
  const normalized = content.toLowerCase();
  if (!isExplicitRememberRequest(content, normalized)) {
    return { preferences: {}, factText: "" };
  }

  const preferences = extractPreferenceUpdates(normalized);
  return {
    preferences,
    factText: Object.keys(preferences).length === 0 ? extractFactText(content) : ""
  };
}

interface RememberExplicitMemoryOptions {
  state: ThreadMemoryState;
  conversationId: string;
  message: GatewayMessage;
  ownerId: string;
  now: string;
}

/**
 * Function: Applies one explicit memory command to an in-memory thread state.
 * Inputs:
 * - state: Mutable memory state for a conversation.
 * - conversationId: Stable conversation identifier used in memory ids.
 * - message: Candidate user message that may contain "remember" intent.
 * - ownerId: Local owner marker stored on generated memory items.
 * - now: ISO timestamp used for created/updated fields.
 * Output:
 * - Mutates the provided state when the message contains explicit memory.
 * Side effects:
 * - Updates in-process memory only.
 * Errors:
 * - Invalid or non-memory messages are ignored.
 */
function rememberExplicitMemoryFromMessage(options: RememberExplicitMemoryOptions): void {
  const extracted = extractExplicitMemoryFromMessage(options.message);
  for (const [key, value] of Object.entries(extracted.preferences)) {
    options.state.preferences[key] = value;
    upsertMemoryItem(options.state.persistentMemories, {
      id: preferenceMemoryId(options.conversationId, key),
      ownerId: options.ownerId,
      conversationId: options.conversationId,
      type: "preference",
      text: `${key}: ${value}`,
      tags: ["preference", `preference:${key}`],
      source: "user_explicit",
      now: options.now
    });
  }
  if (extracted.factText) {
    upsertMemoryItem(options.state.persistentMemories, {
      id: factMemoryId(options.conversationId, extracted.factText),
      ownerId: options.ownerId,
      conversationId: options.conversationId,
      type: "fact",
      text: extracted.factText,
      tags: ["fact"],
      source: "user_explicit",
      now: options.now
    });
  }
}

interface UpsertMemoryItemInput {
  id: string;
  ownerId: string;
  conversationId: string;
  type: AgentMemoryItemType;
  text: string;
  tags: string[];
  source: AgentMemoryItemSource;
  key?: string;
  scope?: AgentMemoryScope;
  confidence?: number;
  importance?: number;
  sensitivity?: AgentMemorySensitivity;
  evidence?: string;
  now: string;
}

interface MemoryItemInputForSaveOptions {
  conversationId: string;
  input: SaveAgentMemoryInput;
  ownerId: string;
  now: string;
}

/**
 * Function: Converts user/API save input into a complete memory item upsert.
 * Inputs:
 * - conversationId: Conversation that owns this memory.
 * - input: Validated save request.
 * - ownerId: Local owner marker for the created item.
 * - now: ISO timestamp used for created/updated fields.
 * Output:
 * - Upsert-ready memory item data.
 * Side effects:
 * - None.
 * Errors:
 * - Throws when text is empty.
 */
export function memoryItemInputForSave(options: MemoryItemInputForSaveOptions): UpsertMemoryItemInput {
  const text = options.input.text.trim();
  if (!text) throw new Error("memory text must be non-empty");
  if (containsCredentialLikeSecret(text)) throw new Error("memory text contains credential-like secret");
  const type = options.input.type || "fact";
  const tags = normalizedTags(options.input.tags);
  return {
    id: options.input.id || memoryIdForSave(
      options.conversationId,
      type,
      text,
      tags,
      options.input.key,
      options.input.scope
    ),
    ownerId: options.ownerId,
    conversationId: options.conversationId,
    type,
    text: truncateMemoryText(text),
    tags: tagsForMemory(type, tags),
    source: options.input.source || "user_explicit",
    ...(options.input.key ? { key: options.input.key } : {}),
    ...(options.input.scope ? { scope: options.input.scope } : {}),
    ...(typeof options.input.confidence === "number" ? { confidence: options.input.confidence } : {}),
    ...(typeof options.input.importance === "number" ? { importance: options.input.importance } : {}),
    ...(options.input.sensitivity ? { sensitivity: options.input.sensitivity } : {}),
    ...(options.input.evidence ? { evidence: options.input.evidence } : {}),
    now: options.now
  };
}

/**
 * Function: Inserts or updates one memory item in a mutable list.
 * Inputs:
 * - items: Mutable list of memory items.
 * - input: Complete memory item data except createdAt/updatedAt split.
 * Output:
 * - Returns true when the list changed.
 * Side effects:
 * - Mutates `items` in place.
 * Errors:
 * - Empty text is ignored and returns false.
 */
export function upsertMemoryItem(items: AgentMemoryItem[], input: UpsertMemoryItemInput): boolean {
  if (!input.text.trim()) return false;
  const existing = items.find((item) => item.id === input.id);
  if (existing) {
    if (
      existing.text === input.text &&
      existing.type === input.type &&
      existing.source === input.source &&
      existing.key === input.key &&
      existing.scope === input.scope &&
      existing.confidence === input.confidence &&
      existing.importance === input.importance &&
      existing.sensitivity === input.sensitivity &&
      existing.evidence === input.evidence &&
      existing.deletedAt === undefined
    ) {
      return false;
    }
    existing.ownerId = input.ownerId;
    existing.conversationId = input.conversationId;
    existing.type = input.type;
    existing.text = input.text;
    existing.tags = [...input.tags];
    existing.source = input.source;
    assignOptionalMemoryMetadata(existing, input);
    existing.updatedAt = input.now;
    delete existing.deletedAt;
    return true;
  }
  items.push({
    id: input.id,
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    type: input.type,
    text: input.text,
    tags: [...input.tags],
    source: input.source,
    ...(input.key ? { key: input.key } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
    ...(typeof input.importance === "number" ? { importance: input.importance } : {}),
    ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    createdAt: input.now,
    updatedAt: input.now
  });
  return true;
}

/**
 * Function: Soft-deletes one memory item by id.
 * Inputs:
 * - items: Mutable memory item list.
 * - id: Memory id to delete.
 * - now: ISO timestamp used for deletion/update fields.
 * Output:
 * - True when an active item was marked deleted.
 * Side effects:
 * - Mutates `items` in place.
 * Errors:
 * - Missing ids return false.
 */
export function softDeleteMemoryItem(items: AgentMemoryItem[], id: string, now: string): boolean {
  const existing = items.find((item) => item.id === id && !item.deletedAt);
  if (!existing) return false;
  existing.deletedAt = now;
  existing.updatedAt = now;
  return true;
}

/**
 * Function: Finds an active or recently updated memory item by id.
 * Inputs:
 * - items: Memory item list.
 * - id: Memory id to find.
 * Output:
 * - A cloned memory item.
 * Side effects:
 * - None.
 * Errors:
 * - Throws when the item cannot be found.
 */
export function memoryItemById(items: AgentMemoryItem[], id: string): AgentMemoryItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`memory item not found: ${id}`);
  return { ...item, tags: [...item.tags] };
}

/**
 * Function: Builds the stable id for a conversation preference memory.
 * Inputs:
 * - conversationId: Conversation that owns this preference.
 * - key: Preference key such as `response_style`.
 * Output:
 * - A deterministic string id safe to store in JSON.
 * Side effects:
 * - None.
 * Errors:
 * - None.
 */
export function preferenceMemoryId(conversationId: string, key: string): string {
  return `preference:${encodeIdPart(conversationId)}:${key}`;
}

/**
 * Function: Builds a stable id for an explicit fact memory.
 * Inputs:
 * - conversationId: Conversation that owns this fact.
 * - text: User-approved fact text.
 * Output:
 * - A deterministic string id based on conversation and text.
 * Side effects:
 * - None.
 * Errors:
 * - None.
 */
export function factMemoryId(conversationId: string, text: string): string {
  return `fact:${encodeIdPart(conversationId)}:${encodeIdPart(text.toLowerCase().slice(0, 160))}`;
}

/**
 * Function: Returns active memory items for a snapshot or model prompt.
 * Inputs:
 * - items: Memory items that may include soft-deleted entries.
 * Output:
 * - Non-deleted items sorted by update time, oldest first.
 * Side effects:
 * - None.
 * Errors:
 * - None.
 */
export function activeMemories(items: AgentMemoryItem[]): AgentMemoryItem[] {
  return items
    .filter((item) => !item.deletedAt)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map((item) => ({ ...item, tags: [...item.tags] }));
}

/**
 * Function: Derives preference key/value pairs from active memory items.
 * Inputs:
 * - items: Memory items from the persistent memory file.
 * Output:
 * - Preference map used by existing thread-memory prompts.
 * Side effects:
 * - None.
 * Errors:
 * - Items without a `preference:<key>` tag are ignored.
 */
export function preferencesFromMemoryItems(items: AgentMemoryItem[]): Record<string, string> {
  const preferences: Record<string, string> = {};
  for (const item of activeMemories(items)) {
    if (item.type !== "preference") continue;
    const key = item.tags
      .map((tag) => tag.startsWith("preference:") ? tag.slice("preference:".length) : "")
      .find(Boolean);
    if (!key) continue;
    const value = item.text.startsWith(`${key}:`) ? item.text.slice(key.length + 1).trim() : item.text.trim();
    if (value) preferences[key] = value;
  }
  return preferences;
}

function extractPreferenceUpdates(content: string): Record<string, string> {
  const preferences: Record<string, string> = {};

  if (content.includes("简短") || content.includes("concise") || content.includes("short")) {
    preferences.response_style = "concise";
  }
  if (content.includes("详细") || content.includes("verbose") || content.includes("detailed")) {
    preferences.response_style = "detailed";
  }
  if (content.includes("中文") || content.includes("chinese")) {
    preferences.language = "zh-CN";
  }
  if (content.includes("english") || content.includes("英文")) {
    preferences.language = "en";
  }
  return preferences;
}

function isExplicitRememberRequest(content: string, normalized: string): boolean {
  return /^\s*(?:please\s+)?remember(?:\s+that)?\s+/i.test(content) ||
    /^\s*请?记住[:：]?\s*/u.test(content) ||
    normalized.startsWith("记住");
}

function extractFactText(content: string): string {
  const trimmed = content.trim();
  const english = trimmed.match(/^\s*(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i)?.[1];
  const chinese = trimmed.match(/^\s*请?记住[:：]?\s*(.+)$/u)?.[1];
  return truncateMemoryText((english || chinese || "").trim());
}

function memoryIdForSave(
  conversationId: string,
  type: AgentMemoryItemType,
  text: string,
  tags: string[],
  key?: string,
  scope?: AgentMemoryScope
): string {
  if (key) {
    const prefix = scope === "owner" ? "owner" : encodeIdPart(conversationId);
    return `memory:${prefix}:${encodeIdPart(key)}`;
  }
  const preferenceTag = tags.find((tag) => tag.startsWith("preference:"));
  if (type === "preference" && preferenceTag) {
    return preferenceMemoryId(conversationId, preferenceTag.slice("preference:".length));
  }
  if (type === "preference") {
    return preferenceMemoryId(conversationId, "custom");
  }
  return factMemoryId(conversationId, text);
}

function assignOptionalMemoryMetadata(existing: AgentMemoryItem, input: UpsertMemoryItemInput): void {
  const fields: Array<keyof Pick<
    AgentMemoryItem,
    "key" | "scope" | "confidence" | "importance" | "sensitivity" | "evidence"
  >> = ["key", "scope", "confidence", "importance", "sensitivity", "evidence"];
  for (const field of fields) {
    const value = input[field];
    if (value === undefined) {
      delete existing[field];
    } else {
      (existing as unknown as Record<string, unknown>)[field] = value;
    }
  }
}

function normalizedTags(tags: string[] | undefined): string[] {
  return [...new Set((tags || [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12))];
}

function tagsForMemory(type: AgentMemoryItemType, tags: string[]): string[] {
  const base = type === "preference" ? ["preference"] : [type];
  return [...new Set([...base, ...tags])];
}

function truncateMemoryText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function truncateLine(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function encodeIdPart(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function trimMessages(messages: GatewayMessage[], maxMessages: number): void {
  if (messages.length <= maxMessages) return;
  messages.splice(0, messages.length - maxMessages);
}
