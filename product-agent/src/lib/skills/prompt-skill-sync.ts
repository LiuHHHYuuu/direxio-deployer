import { PROMPT_SKILL_SCHEMA, type PromptSkillDefinition } from "./prompt-skill.js";
import {
  PromptSkillValidationError,
  type PromptSkillStore
} from "./prompt-skill-store.js";

export interface PromptSkillSyncError {
  index: number;
  message: string;
  errors: string[];
}

export interface PromptSkillSyncResult {
  saved: PromptSkillDefinition[];
  skipped: number;
  errors: PromptSkillSyncError[];
}

/**
 * Function: Upserts user-authored Prompt Skills from plugin config-shaped data.
 * Inputs:
 * - store: Product-agent Prompt Skill store to update.
 * - input: Request body, agent event, plugin config, or direct skill array.
 * Output:
 * - Summary of saved, skipped, and invalid Prompt Skill entries.
 * Side effects:
 * - Writes valid Prompt Skills into the configured store.
 * Errors:
 * - Invalid Prompt Skill candidates are reported in the result; non-prompt
 *   developer skill entries are skipped.
 */
export function syncPromptSkillsFromConfig(
  store: PromptSkillStore,
  input: unknown
): PromptSkillSyncResult {
  const entries = promptSkillEntriesFromConfig(input);
  const saved: PromptSkillDefinition[] = [];
  const errors: PromptSkillSyncError[] = [];
  let skipped = 0;

  entries.forEach((entry, index) => {
    if (!isPromptSkillCandidate(entry)) {
      skipped += 1;
      return;
    }
    try {
      saved.push(store.saveSkill(entry));
    } catch (error) {
      const validationErrors = error instanceof PromptSkillValidationError
        ? error.errors
        : [error instanceof Error ? error.message : "invalid prompt skill"];
      errors.push({
        index,
        message: validationErrors.join("; "),
        errors: validationErrors
      });
    }
  });

  return { saved, skipped, errors };
}

/**
 * Function: Extracts possible skill entries from all bridge shapes we accept.
 * Inputs:
 * - input: Direct array, `{ skills }`, `{ prompt_skills }`, `{ agent_config }`,
 *   `{ plugin_config }`, or `{ config }`.
 * Output:
 * - Flat list of skill-like entries.
 * Side effects:
 * - None.
 * Errors:
 * - None; unknown shapes return an empty list.
 */
export function promptSkillEntriesFromConfig(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  const record = asRecord(input);
  const direct = firstArray([
    record.prompt_skills,
    record.promptSkills,
    record.skills
  ]);
  if (direct) return direct;

  const nested = firstArray([
    asRecord(record.agent_config).skills,
    asRecord(record.plugin_config).skills,
    asRecord(record.config).skills,
    asRecord(record.agentConfig).skills,
    asRecord(record.pluginConfig).skills
  ]);
  return nested || [];
}

function isPromptSkillCandidate(value: unknown): boolean {
  const record = asRecord(value);
  const schema = stringField(record.schema);
  const kind = stringField(record.kind);
  const prompt = stringField(record.prompt);
  return schema === PROMPT_SKILL_SCHEMA ||
    kind === "prompt" ||
    (prompt.length > 0 && hasTriggerExamples(record));
}

function hasTriggerExamples(record: Record<string, unknown>): boolean {
  return Array.isArray(record.triggerExamples) || Array.isArray(record.trigger_examples);
}

function firstArray(values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
