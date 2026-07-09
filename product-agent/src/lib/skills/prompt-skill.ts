import type { AgentToolPermission } from "../tools/types.js";

export const PROMPT_SKILL_SCHEMA = "direxio.prompt_skill.v1";

export interface PromptSkillDefinition {
  schema: typeof PROMPT_SKILL_SCHEMA;
  id: string;
  title: string;
  description: string;
  prompt: string;
  triggerExamples: string[];
  outputKind: "text" | "agent_action_result";
  permissions: AgentToolPermission[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptSkillSaveInput {
  id?: string;
  title: string;
  description: string;
  prompt: string;
  triggerExamples: string[];
  outputKind?: "text" | "agent_action_result";
  permissions?: AgentToolPermission[];
  enabled?: boolean;
}

export interface PromptSkillValidationResult {
  ok: boolean;
  errors: string[];
  skill?: PromptSkillDefinition;
}

/**
 * Function: Validates and normalizes a user-uploaded Prompt Skill.
 * Inputs:
 * - input: Raw request body from API, tests, or future App upload UI.
 * - now: ISO timestamp used when creating/updating skill metadata.
 * Output:
 * - A validation result containing either normalized skill data or errors.
 * Side effects:
 * - None; this function does not persist data.
 * Errors:
 * - Invalid fields are returned as validation errors instead of thrown.
 */
export function validatePromptSkill(input: unknown, now: string): PromptSkillValidationResult {
  const record = asRecord(input);
  const title = stringField(record.title).slice(0, 80);
  const description = stringField(record.description).slice(0, 300);
  const prompt = stringField(record.prompt).slice(0, 4000);
  const triggerExamples = stringList(record.triggerExamples || record.trigger_examples).slice(0, 12);
  const outputKind = outputKindField(record.outputKind || record.output_kind);
  const rawPermissions = Array.isArray(record.permissions) ? record.permissions : [];
  const permissions = permissionsField(record.permissions);
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const id = stringField(record.id) || promptSkillId(title);
  const errors: string[] = [];

  if (!title) errors.push("title is required");
  if (!description) errors.push("description is required");
  if (!prompt) errors.push("prompt is required");
  if (triggerExamples.length === 0) errors.push("triggerExamples must include at least one example");
  if (!outputKind) errors.push("outputKind must be text or agent_action_result");
  if (!id) errors.push("id could not be generated from title");
  if (rawPermissions.length !== permissions.length) {
    errors.push("permissions include unsupported scope or access");
  }

  if (errors.length > 0 || !outputKind || !id) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    skill: {
      schema: PROMPT_SKILL_SCHEMA,
      id,
      title,
      description,
      prompt,
      triggerExamples,
      outputKind,
      permissions: permissions.length ? permissions : [
        { scope: "current_ai_thread", access: "read", required: false }
      ],
      enabled,
      createdAt: stringField(record.createdAt) || now,
      updatedAt: now
    }
  };
}

/**
 * Function: Normalizes a persisted Prompt Skill read from disk.
 * Inputs:
 * - value: Unknown JSON value from the skill store.
 * Output:
 * - A valid Prompt Skill or null when the record is unusable.
 * Side effects:
 * - None.
 * Errors:
 * - Invalid records return null.
 */
export function normalizePromptSkill(value: unknown): PromptSkillDefinition | null {
  const record = asRecord(value);
  const result = validatePromptSkill(record, stringField(record.updatedAt) || new Date(0).toISOString());
  if (!result.ok || !result.skill) return null;
  return {
    ...result.skill,
    createdAt: stringField(record.createdAt) || result.skill.createdAt,
    updatedAt: stringField(record.updatedAt) || result.skill.updatedAt
  };
}

/**
 * Function: Generates a stable skill id from a human title.
 * Inputs:
 * - title: User-facing skill title.
 * Output:
 * - Lowercase id prefixed for Prompt Skill namespace.
 * Side effects:
 * - None.
 * Errors:
 * - Empty titles return an empty string.
 */
export function promptSkillId(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized ? `prompt-${normalized}` : "";
}

function permissionsField(value: unknown): AgentToolPermission[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      return {
        scope: record.scope,
        access: record.access,
        required: record.required === true
      };
    })
    .filter((item): item is AgentToolPermission => isAllowedPromptSkillPermission(item));
}

function isAllowedPromptSkillPermission(value: unknown): value is AgentToolPermission {
  const record = asRecord(value);
  const scope = record.scope;
  const access = record.access;
  return (scope === "current_ai_thread" || scope === "thread_memory") &&
    (access === "read" || access === "write") &&
    typeof record.required === "boolean";
}

function outputKindField(value: unknown): PromptSkillDefinition["outputKind"] | "" {
  return value === "text" || value === "agent_action_result" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean))]
    : [];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
