import type { PromptSkillDefinition } from "../skills/prompt-skill.js";
import type { AgentTool, AgentToolManifest, AgentToolResult } from "./types.js";

/**
 * Function: Converts enabled Prompt Skill definitions into agent tools.
 * Inputs:
 * - skills: Stored user Prompt Skills.
 * Output:
 * - Agent tools that inject prompt instructions for matching user requests.
 * Side effects:
 * - None; tools only read the skill definition captured at creation time.
 * Errors:
 * - Disabled skills are skipped.
 */
export function createPromptSkillTools(skills: PromptSkillDefinition[]): AgentTool[] {
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      name: toolNameForPromptSkill(skill),
      description: skill.description,
      manifest: manifestForPromptSkill(skill),
      run: async (input) => ok(toolNameForPromptSkill(skill), promptSkillContext(skill, input))
    }));
}

/**
 * Function: Creates the stable tool name for a Prompt Skill.
 * Inputs:
 * - skill: Prompt Skill definition.
 * Output:
 * - Tool name safe for OpenAI-compatible function calling.
 * Side effects:
 * - None.
 * Errors:
 * - None.
 */
export function toolNameForPromptSkill(skill: PromptSkillDefinition): string {
  return `prompt_skill_${skill.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`;
}

function manifestForPromptSkill(skill: PromptSkillDefinition): AgentToolManifest {
  return {
    schema: "direxio.agent_tool.v1",
    name: toolNameForPromptSkill(skill),
    title: skill.title,
    description: skill.description,
    category: "experience",
    source: "user",
    skillKind: "prompt",
    defaultEnabled: skill.enabled,
    permissions: skill.permissions,
    inputSchema: {
      type: "object",
      properties: {
        user_message: { type: "string" }
      },
      additionalProperties: false
    },
    outputKind: skill.outputKind,
    triggerExamples: [...skill.triggerExamples],
    shareable: skill.outputKind === "agent_action_result"
  };
}

function promptSkillContext(skill: PromptSkillDefinition, input: Record<string, unknown>): string {
  return [
    `Prompt Skill: ${skill.title}`,
    `Description: ${skill.description}`,
    "Instruction:",
    skill.prompt,
    stringInput(input.user_message) ? `User message: ${stringInput(input.user_message)}` : "",
    skill.outputKind === "agent_action_result"
      ? "Return a concise direxio.agent_action_result.v1 card if appropriate. Do not paste raw JSON as normal prose."
      : "Return concise user-facing text."
  ].filter(Boolean).join("\n");
}

function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ok(name: string, content: string): AgentToolResult {
  return { name, ok: true, content };
}

