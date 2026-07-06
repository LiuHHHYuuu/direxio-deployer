export type AgentAbilityPermissionScope =
  | "current_ai_thread"
  | "thread_memory"
  | "explicit_selected_context";

export interface AgentAbilityPermission {
  scope: AgentAbilityPermissionScope;
  access: "read";
  required: boolean;
}

export interface AgentAbilityManifest {
  id: string;
  title: string;
  description: string;
  permissions: AgentAbilityPermission[];
  defaultVisibility: "private";
  outputKind: "experience_card";
}

export interface AgentExperienceCardSection {
  label: string;
  value: string | string[];
}

export interface AgentExperienceCard {
  schema: "direxio.agent_experience_card.v1";
  cardType: "persona_card" | "memory_capsule" | "mood_card";
  title: string;
  subtitle: string;
  highlights: string[];
  sections: AgentExperienceCardSection[];
  prompts: string[];
  privacy: {
    sourceScope: "current_ai_thread";
    defaultVisibility: "private";
    shareRequiresUserAction: true;
  };
}
