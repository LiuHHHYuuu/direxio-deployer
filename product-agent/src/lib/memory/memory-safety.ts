const CREDENTIAL_PATTERN = /(?:\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|recovery[_ -]?code|private[_ -]?key)\b\s*[:=]?\s*\S+|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-[A-Za-z0-9_-]{8,})/gi;

export function containsCredentialLikeSecret(value: string): boolean {
  return new RegExp(CREDENTIAL_PATTERN.source, "i").test(value);
}

export function redactCredentialLikeSecrets(value: string): string {
  return value.replace(new RegExp(CREDENTIAL_PATTERN.source, "gi"), "[redacted secret]");
}
