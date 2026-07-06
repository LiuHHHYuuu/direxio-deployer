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
  action: AgentActionName;
  title: string;
  shortTitle: string;
  description: string;
  permissions: AgentAbilityPermission[];
  defaultVisibility: "private";
  outputKind: "agent_action_result";
}

export type AgentActionName = "persona_card" | "memory_capsule" | "mood_card";

export interface AgentActionMenuItem {
  action: AgentActionName;
  title: string;
  subtitle: string;
  icon: "user" | "archive" | "sparkles";
}

export interface AgentActionMenu {
  schema: "direxio.agent_action_menu.v1";
  title: string;
  items: AgentActionMenuItem[];
}

export interface AgentActionResult {
  schema: "direxio.agent_action_result.v1";
  action: AgentActionName;
  title: string;
  summary: string;
  points: string[];
  nextActions: string[];
  privacy: {
    sourceScope: "current_ai_thread";
    defaultVisibility: "private";
    shareRequiresUserAction: true;
  };
}
