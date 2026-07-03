#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const TOKEN_PREFIX = "dxai_";
const TOKEN_BYTES = 32;
const count = readCount(process.argv[2]);

for (let index = 0; index < count; index += 1) {
  process.stdout.write(`${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}\n`);
}

function readCount(value) {
  if (value === undefined) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    console.error("Usage: npm run token:generate -- [count:1-100]");
    process.exit(1);
  }
  return parsed;
}
