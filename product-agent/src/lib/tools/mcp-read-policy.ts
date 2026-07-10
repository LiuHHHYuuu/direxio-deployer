import type { GatewayChatRequest } from "../types.js";
import type { ReadOnlyDirexioMcpToolName } from "../mcp/read-only-direxio-mcp-client.js";

const INTENT_TERMS: Record<ReadOnlyDirexioMcpToolName, string[]> = {
  list_contacts: ["联系人", "好友", "朋友列表", "通讯录", "contact", "friend"],
  search_rooms: [
    "房间", "聊天室", "会话列表", "群聊", "群组", "频道", "联系人", "好友",
    "room", "conversation list", "group", "channel", "contact", "friend"
  ],
  list_messages: [
    "消息", "聊天记录", "对话记录", "最近聊", "聊了什么", "说了什么", "谁找我",
    "message", "chat history", "conversation history", "recent chat"
  ],
  list_room_members: [
    "成员", "群里有谁", "频道里有谁", "参与者", "member", "participant", "who is in"
  ],
  list_channel_posts: [
    "频道帖子", "频道内容", "帖子", "动态", "post", "channel feed", "channel content"
  ],
  list_post_comments: ["评论", "帖子回复", "comment", "post reply", "replies to the post"]
};

export function latestUserExplicitlyAuthorizesMcpRead(
  toolName: ReadOnlyDirexioMcpToolName,
  payload: GatewayChatRequest
): boolean {
  const latestUser = [...payload.messages].reverse().find((message) => message.role === "user");
  const normalized = latestUser?.content.trim().toLowerCase() || "";
  if (!normalized) return false;
  if (INTENT_TERMS[toolName].some((term) => normalized.includes(term))) return true;
  if (toolName === "search_rooms" || toolName === "list_messages") {
    return /(?:和|与).{1,80}(?:最近)?(?:聊|说)|(?:summari[sz]e|show|find).{0,80}(?:chat|messages?)/i.test(normalized);
  }
  return false;
}

export function textExplicitlyRequestsPrivateAppData(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return Object.values(INTENT_TERMS).some((terms) => terms.some((term) => normalized.includes(term))) ||
    /(?:和|与).{1,80}(?:最近)?(?:聊|说)|(?:summari[sz]e|show|find).{0,80}(?:chat|messages?)/i.test(normalized);
}
