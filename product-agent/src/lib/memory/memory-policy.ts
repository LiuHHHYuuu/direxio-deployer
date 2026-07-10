import type { MemoryCandidate } from "./memory-candidate.js";
import { containsCredentialLikeSecret } from "./memory-safety.js";

export interface MemoryPolicyOptions {
  minConfidence: number;
  minImportance: number;
}

export interface MemoryPolicyContext {
  latestUserMessage: string;
  explicitRequest: boolean;
}

export interface MemoryPolicyDecision {
  accepted: boolean;
  reason: string;
  candidate: MemoryCandidate;
}

/** Applies deterministic privacy and value rules to one untrusted model candidate. */
export function evaluateMemoryCandidate(
  candidate: MemoryCandidate,
  context: MemoryPolicyContext,
  options: MemoryPolicyOptions
): MemoryPolicyDecision {
  const reject = (reason: string): MemoryPolicyDecision => ({ accepted: false, reason, candidate });
  if (!isAllowedMemoryKey(candidate.key)) return reject("unsupported_key");
  if (candidate.operation === "noop") return reject("model_noop");
  if (!evidenceMatchesLatestMessage(candidate.evidence, context.latestUserMessage)) {
    return reject("ungrounded_evidence");
  }
  if (
    candidate.operation !== "delete" &&
    candidate.key.startsWith("profile.location.") &&
    !statesDurableLocation(context.latestUserMessage)
  ) {
    return reject("location_not_durable");
  }
  if (containsCredentialLikeSecret(`${context.latestUserMessage}\n${candidate.text}`)) {
    return reject("secret_detected");
  }
  if (candidate.sensitivity === "secret") return reject("secret_candidate");
  if (candidate.sensitivity === "sensitive" && !context.explicitRequest) {
    return reject("sensitive_without_explicit_request");
  }
  if (!context.explicitRequest && candidate.confidence < options.minConfidence) {
    return reject("low_confidence");
  }
  if (!context.explicitRequest && candidate.importance < options.minImportance) {
    return reject("low_importance");
  }
  return { accepted: true, reason: "accepted", candidate };
}

export function isExplicitMemoryInstruction(value: string): boolean {
  return /(?:\bremember\b|\bforget\b|\bupdate (?:my|the)\b|\bcorrect (?:my|the)\b|记住|记下来|忘记|不要记|删掉.*记忆|改成|更正)/iu.test(value);
}

function isAllowedMemoryKey(value: string): boolean {
  return /^(?:profile|preference|goal|project)\.[a-z0-9][a-z0-9_.-]{1,118}$/i.test(value);
}

function evidenceMatchesLatestMessage(evidence: string, latestUserMessage: string): boolean {
  const normalizedEvidence = normalizeText(evidence);
  return normalizedEvidence.length >= 2 && normalizeText(latestUserMessage).includes(normalizedEvidence);
}

function statesDurableLocation(value: string): boolean {
  return /(?:我.{0,8}(?:住在|居住在|常住|搬到|家在)|\bI\s+(?:live|moved)\s+(?:in|to)\b|\bmy\s+home\s+is\b)/iu.test(value);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
