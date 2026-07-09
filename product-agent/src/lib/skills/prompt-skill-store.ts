import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  normalizePromptSkill,
  PROMPT_SKILL_SCHEMA,
  validatePromptSkill,
  type PromptSkillDefinition,
  type PromptSkillSaveInput,
  type PromptSkillValidationResult
} from "./prompt-skill.js";

const PROMPT_SKILL_FILE_SCHEMA = "direxio.prompt_skill_store.v1";

export interface PromptSkillStore {
  listSkills(): PromptSkillDefinition[];
  validateSkill(input: unknown): PromptSkillValidationResult;
  saveSkill(input: unknown): PromptSkillDefinition;
  deleteSkill(id: string): boolean;
}

export class PromptSkillValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "PromptSkillValidationError";
  }
}

export interface PromptSkillStoreOptions {
  dataDir?: string;
  filePath?: string;
  now?: () => Date;
}

interface PromptSkillFileDocument {
  schema: typeof PROMPT_SKILL_FILE_SCHEMA;
  skills: PromptSkillDefinition[];
}

/**
 * Function: Creates the default Prompt Skill store for the current service process.
 * Inputs:
 * - env: Environment variables that may include `DIREXIO_AGENT_DATA_DIR`.
 * Output:
 * - File-backed store when data dir is set, otherwise in-memory store.
 * Side effects:
 * - None during construction beyond creating the object.
 * Errors:
 * - Empty data dir falls back to in-memory behavior.
 */
export function createDefaultPromptSkillStore(env: NodeJS.ProcessEnv = process.env): PromptSkillStore {
  const dataDir = env.DIREXIO_AGENT_DATA_DIR?.trim();
  return dataDir ? new FileBackedPromptSkillStore({ dataDir }) : new InMemoryPromptSkillStore();
}

/**
 * Function: Stores Prompt Skills in process memory for local tests and no-data-dir runtime.
 * Inputs:
 * - options.now: Optional clock for deterministic tests.
 * Output:
 * - PromptSkillStore implementation.
 * Side effects:
 * - Keeps skills only in this process.
 * Errors:
 * - Invalid skill saves throw PromptSkillValidationError.
 */
export class InMemoryPromptSkillStore implements PromptSkillStore {
  private readonly skills = new Map<string, PromptSkillDefinition>();
  private readonly now: () => Date;

  constructor(options: PromptSkillStoreOptions = {}) {
    this.now = options.now || (() => new Date());
  }

  listSkills(): PromptSkillDefinition[] {
    return [...this.skills.values()].map(cloneSkill);
  }

  validateSkill(input: unknown): PromptSkillValidationResult {
    return validatePromptSkill(input, this.now().toISOString());
  }

  saveSkill(input: unknown): PromptSkillDefinition {
    const skill = normalizedSkillOrThrow(input, this.now().toISOString(), this.skills.get(skillIdFromInput(input)));
    this.skills.set(skill.id, skill);
    return cloneSkill(skill);
  }

  deleteSkill(id: string): boolean {
    return this.skills.delete(id);
  }
}

/**
 * Function: Stores Prompt Skills in `$DIREXIO_AGENT_DATA_DIR/skills/prompt-skills.json`.
 * Inputs:
 * - options.dataDir: Product-agent runtime data directory.
 * - options.filePath: Optional test override for the JSON path.
 * - options.now: Optional clock for deterministic tests.
 * Output:
 * - PromptSkillStore implementation.
 * Side effects:
 * - Reads and writes a JSON file with atomic rename writes.
 * Errors:
 * - Invalid skill saves throw PromptSkillValidationError; corrupt JSON throws parse errors.
 */
export class FileBackedPromptSkillStore implements PromptSkillStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: PromptSkillStoreOptions) {
    this.filePath = options.filePath || join(options.dataDir || ".", "skills", "prompt-skills.json");
    this.now = options.now || (() => new Date());
  }

  listSkills(): PromptSkillDefinition[] {
    return this.readDocument().skills.map(cloneSkill);
  }

  validateSkill(input: unknown): PromptSkillValidationResult {
    return validatePromptSkill(input, this.now().toISOString());
  }

  saveSkill(input: unknown): PromptSkillDefinition {
    const document = this.readDocument();
    const existing = document.skills.find((skill) => skill.id === skillIdFromInput(input));
    const skill = normalizedSkillOrThrow(input, this.now().toISOString(), existing);
    const index = document.skills.findIndex((item) => item.id === skill.id);
    if (index >= 0) {
      document.skills[index] = skill;
    } else {
      document.skills.push(skill);
    }
    this.writeDocument(document);
    return cloneSkill(skill);
  }

  deleteSkill(id: string): boolean {
    const document = this.readDocument();
    const next = document.skills.filter((skill) => skill.id !== id);
    if (next.length === document.skills.length) return false;
    this.writeDocument({ schema: PROMPT_SKILL_FILE_SCHEMA, skills: next });
    return true;
  }

  private readDocument(): PromptSkillFileDocument {
    if (!existsSync(this.filePath)) {
      return { schema: PROMPT_SKILL_FILE_SCHEMA, skills: [] };
    }
    const raw = readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    const skills = Array.isArray(record.skills)
      ? record.skills.map(normalizePromptSkill).filter((skill): skill is PromptSkillDefinition => Boolean(skill))
      : [];
    return { schema: PROMPT_SKILL_FILE_SCHEMA, skills };
  }

  private writeDocument(document: PromptSkillFileDocument): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const body = `${JSON.stringify({
      schema: PROMPT_SKILL_FILE_SCHEMA,
      skills: document.skills
    }, null, 2)}\n`;
    writeFileSync(tmpPath, body, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

function normalizedSkillOrThrow(
  input: unknown,
  now: string,
  existing?: PromptSkillDefinition
): PromptSkillDefinition {
  const merged = existing ? {
    ...inputAsRecord(input),
    createdAt: existing.createdAt
  } : input;
  const result = validatePromptSkill(merged, now);
  if (!result.ok || !result.skill) throw new PromptSkillValidationError(result.errors);
  return {
    ...result.skill,
    schema: PROMPT_SKILL_SCHEMA,
    createdAt: existing?.createdAt || result.skill.createdAt,
    updatedAt: now
  };
}

function skillIdFromInput(input: unknown): string {
  return typeof asRecord(input).id === "string" ? String(asRecord(input).id).trim() : "";
}

function cloneSkill(skill: PromptSkillDefinition): PromptSkillDefinition {
  return {
    ...skill,
    triggerExamples: [...skill.triggerExamples],
    permissions: skill.permissions.map((permission) => ({ ...permission }))
  };
}

function inputAsRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

