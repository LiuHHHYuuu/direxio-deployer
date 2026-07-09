import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GatewayMessage } from "../types.js";
import {
  activeMemories,
  extractExplicitMemoryFromMessage,
  factMemoryId,
  InMemoryThreadMemoryStore,
  memoryItemById,
  memoryItemInputForSave,
  preferenceMemoryId,
  preferencesFromMemoryItems,
  softDeleteMemoryItem,
  type AgentMemoryItem,
  type AgentMemoryItemSource,
  type AgentMemoryItemType,
  type SaveAgentMemoryInput,
  type ThreadMemorySnapshot,
  type ThreadMemoryStore,
  upsertMemoryItem
} from "./thread-memory.js";
import { FileBackedMemoryVectorIndex, type ThreadMemorySearchInput } from "./vector-memory.js";

const MEMORY_FILE_SCHEMA = "direxio.agent_memory_items.v1";

export interface FileBackedThreadMemoryStoreOptions {
  dataDir: string;
  filePath?: string;
  ownerId?: string;
  maxMessages?: number;
  compressionChunkMessages?: number;
  autoCompact?: boolean;
  now?: () => Date;
}

interface MemoryFileDocument {
  schema: typeof MEMORY_FILE_SCHEMA;
  items: AgentMemoryItem[];
}

/**
 * Function: Stores explicit agent memory in a JSON file while keeping recent chat context in memory.
 * Inputs:
 * - options.dataDir: Root runtime data directory for product-agent.
 * - options.filePath: Optional test override for the memory JSON path.
 * - options.ownerId: Local owner marker for created memory items.
 * - options.maxMessages: Maximum recent messages kept in process memory.
 * - options.now: Optional clock used by tests.
 * Output:
 * - A ThreadMemoryStore implementation suitable for local and hosted product-agent runtimes.
 * Side effects:
 * - Reads and writes `$dataDir/memory/items.json` with atomic rename writes.
 * Errors:
 * - Throws when the memory file exists but is not readable JSON, or when disk writes fail.
 */
export class FileBackedThreadMemoryStore implements ThreadMemoryStore {
  private readonly recentStore: InMemoryThreadMemoryStore;
  private readonly vectorIndex: FileBackedMemoryVectorIndex;
  private readonly filePath: string;
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly autoCompact: boolean;

  constructor(options: FileBackedThreadMemoryStoreOptions) {
    this.filePath = options.filePath || join(options.dataDir, "memory", "items.json");
    this.ownerId = options.ownerId || "self-hosted-node";
    this.now = options.now || (() => new Date());
    this.autoCompact = options.autoCompact ?? true;
    this.recentStore = new InMemoryThreadMemoryStore(options.maxMessages, {
      compressionChunkMessages: options.compressionChunkMessages,
      autoCompact: false,
      trimWhenOverLimit: false,
      ownerId: this.ownerId,
      now: this.now
    });
    this.vectorIndex = new FileBackedMemoryVectorIndex({
      dataDir: options.dataDir,
      now: this.now
    });
  }

  /**
   * Function: Remembers recent messages and persists explicit user memory commands.
   * Inputs:
   * - conversationId: Current Direxio AI conversation id.
   * - messages: Normalized gateway messages from the request.
   * Output:
   * - Updates short-term context and writes new explicit memory items.
   * Side effects:
   * - May create or rewrite the memory JSON file.
   * Errors:
   * - Propagates file read/write errors so service health exposes broken persistence.
   */
  rememberMessages(conversationId: string, messages: GatewayMessage[]): void {
    this.recentStore.rememberMessages(conversationId, messages);

    const document = this.readDocument();
    let changed = false;
    const now = this.now().toISOString();
    for (const message of messages) {
      const extracted = extractExplicitMemoryFromMessage(message);
      for (const [key, value] of Object.entries(extracted.preferences)) {
        changed = upsertMemoryItem(document.items, {
          id: preferenceMemoryId(conversationId, key),
          ownerId: this.ownerId,
          conversationId,
          type: "preference",
          text: `${key}: ${value}`,
          tags: ["preference", `preference:${key}`],
          source: "user_explicit",
          now
        }) || changed;
      }
      if (extracted.factText) {
        changed = upsertMemoryItem(document.items, {
          id: factMemoryId(conversationId, extracted.factText),
          ownerId: this.ownerId,
          conversationId,
          type: "fact",
          text: extracted.factText,
          tags: ["fact"],
          source: "user_explicit",
          now
        }) || changed;
      }
    }

    if (changed) this.writeDocument(document);
    this.compactOrTrimRecentMessages(conversationId);
  }

  /**
   * Function: Remembers an assistant reply only in short-term context.
   * Inputs:
   * - conversationId: Current Direxio AI conversation id.
   * - reply: Assistant text returned to the user.
   * Output:
   * - Updates in-process recent message context.
   * Side effects:
   * - Does not write persistent memory.
   * Errors:
   * - None for empty replies; in-memory store handles trimming.
   */
  rememberAssistantReply(conversationId: string, reply: string): void {
    this.recentStore.rememberAssistantReply(conversationId, reply);
    this.compactOrTrimRecentMessages(conversationId);
  }

  /**
   * Function: Builds the memory snapshot used by agent prompts and tools.
   * Inputs:
   * - conversationId: Current Direxio AI conversation id.
   * Output:
   * - Recent messages plus active persisted memories for this conversation.
   * Side effects:
   * - Reads the memory JSON file.
   * Errors:
   * - Throws when the memory file cannot be parsed.
   */
  snapshot(conversationId: string): ThreadMemorySnapshot {
    const recent = this.recentStore.snapshot(conversationId);
    const items = this.itemsForConversation(conversationId);
    return {
      preferences: {
        ...preferencesFromMemoryItems(items),
        ...recent.preferences
      },
      recentMessages: recent.recentMessages,
      persistentMemories: items
    };
  }

  /**
   * Function: Lists active persistent memories for one conversation.
   * Inputs:
   * - conversationId: Current Direxio AI conversation id.
   * Output:
   * - Active persisted memory items visible to this conversation.
   * Side effects:
   * - Reads the memory JSON file.
   * Errors:
   * - Throws when the memory file cannot be parsed.
   */
  listMemories(conversationId: string): AgentMemoryItem[] {
    return this.itemsForConversation(conversationId);
  }

  /**
   * Function: Searches persistent memories for the current conversation.
   * Inputs:
   * - conversationId: Current Direxio AI conversation id.
   * - input: Query text plus optional runtime embedding provider context.
   * Output:
   * - Active memory items ranked by vector similarity.
   * Side effects:
   * - Lazily creates or refreshes `$dataDir/memory/vectors.json`.
   * Errors:
   * - Falls back to local vectors when provider embeddings fail.
   */
  async searchMemories(conversationId: string, input: ThreadMemorySearchInput): Promise<AgentMemoryItem[]> {
    return this.vectorIndex.search(conversationId, input.query, this.itemsForConversation(conversationId), input);
  }

  /**
   * Function: Saves one explicit memory item to disk.
   * Inputs:
   * - conversationId: Current Direxio AI conversation id.
   * - input: Validated memory content, type, tags, and source.
   * Output:
   * - The saved memory item.
   * Side effects:
   * - Rewrites the memory JSON file through an atomic rename.
   * Errors:
   * - Throws when text is empty or disk write fails.
   */
  saveMemory(conversationId: string, input: SaveAgentMemoryInput): AgentMemoryItem {
    const document = this.readDocument();
    const itemInput = memoryItemInputForSave({
      conversationId,
      input,
      ownerId: this.ownerId,
      now: this.now().toISOString()
    });
    upsertMemoryItem(document.items, itemInput);
    this.writeDocument(document);
    return memoryItemById(document.items, itemInput.id);
  }

  /**
   * Function: Soft-deletes one persistent memory item from disk.
   * Inputs:
   * - conversationId: Current Direxio AI conversation id.
   * - id: Memory id to delete.
   * Output:
   * - True when an active item in this conversation was marked deleted.
   * Side effects:
   * - Rewrites the memory JSON file when deletion succeeds.
   * Errors:
   * - Throws when the memory file cannot be read or written.
   */
  deleteMemory(conversationId: string, id: string): boolean {
    const document = this.readDocument();
    const target = document.items.find((item) =>
      item.id === id &&
      !item.deletedAt &&
      (!item.conversationId || item.conversationId === conversationId)
    );
    if (!target) return false;
    const deleted = softDeleteMemoryItem(document.items, id, this.now().toISOString());
    if (deleted) this.writeDocument(document);
    return deleted;
  }

  private itemsForConversation(conversationId: string): AgentMemoryItem[] {
    return activeMemories(this.readDocument().items)
      .filter((item) => !item.conversationId || item.conversationId === conversationId);
  }

  private compactOrTrimRecentMessages(conversationId: string): void {
    if (!this.autoCompact) {
      this.recentStore.trimRecentMessages(conversationId);
      return;
    }
    const summaries = this.recentStore.compactRecentMessages(conversationId, {
      persist: false,
      ownerId: this.ownerId
    });
    if (summaries.length === 0) return;
    const document = this.readDocument();
    let changed = false;
    for (const summary of summaries) {
      changed = upsertMemoryItem(document.items, {
        id: summary.id,
        ownerId: summary.ownerId,
        conversationId: summary.conversationId || conversationId,
        type: summary.type,
        text: summary.text,
        tags: summary.tags,
        source: summary.source,
        now: summary.updatedAt
      }) || changed;
    }
    if (changed) this.writeDocument(document);
  }

  private readDocument(): MemoryFileDocument {
    if (!existsSync(this.filePath)) {
      return { schema: MEMORY_FILE_SCHEMA, items: [] };
    }
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    const items = Array.isArray(record.items)
      ? record.items.map(normalizeMemoryItem).filter((item): item is AgentMemoryItem => Boolean(item))
      : [];
    return { schema: MEMORY_FILE_SCHEMA, items };
  }

  private writeDocument(document: MemoryFileDocument): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify({
      schema: MEMORY_FILE_SCHEMA,
      items: document.items
    }, null, 2)}\n`;
    writeFileSync(tmpPath, body, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

function normalizeMemoryItem(value: unknown): AgentMemoryItem | null {
  const record = asRecord(value);
  const id = stringField(record.id);
  const ownerId = stringField(record.ownerId);
  const type = memoryItemType(record.type);
  const text = stringField(record.text);
  const source = memoryItemSource(record.source);
  const createdAt = stringField(record.createdAt);
  const updatedAt = stringField(record.updatedAt);
  if (!id || !ownerId || !type || !text || !source || !createdAt || !updatedAt) return null;
  return {
    id,
    ownerId,
    ...(stringField(record.conversationId) ? { conversationId: stringField(record.conversationId) } : {}),
    type,
    text,
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    source,
    createdAt,
    updatedAt,
    ...(stringField(record.deletedAt) ? { deletedAt: stringField(record.deletedAt) } : {})
  };
}

function memoryItemType(value: unknown): AgentMemoryItemType | null {
  return value === "preference" ||
    value === "fact" ||
    value === "card_memory" ||
    value === "skill_result" ||
    value === "thread_summary"
    ? value
    : null;
}

function memoryItemSource(value: unknown): AgentMemoryItemSource | null {
  return value === "user_explicit" ||
    value === "agent_card_save" ||
    value === "prompt_skill" ||
    value === "migration" ||
    value === "auto_compression"
    ? value
    : null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
