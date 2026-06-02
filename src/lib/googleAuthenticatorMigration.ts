import type { TOTPEntry } from "../types";

type GoogleAlgorithm = "SHA1" | "SHA256" | "SHA512";

interface OtpParameter {
  secret?: Uint8Array;
  name?: string;
  issuer?: string;
  algorithm?: number;
  digits?: number;
  type?: number;
}

interface MigrationPayload {
  otpParameters: OtpParameter[];
  batchSize?: number;
  batchIndex?: number;
}

export interface GoogleAuthenticatorImportResult {
  entries: TOTPEntry[];
  skipped: string[];
  batchHint?: string;
}

class ProtoReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done() {
    return this.offset >= this.bytes.length;
  }

  readTag() {
    const value = this.readVarint();
    return {
      field: value >> 3,
      wireType: value & 7,
    };
  }

  readVarint() {
    let shift = 0;
    let result = 0;

    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("迁移数据中的数字字段过大");
    }

    throw new Error("迁移数据不完整");
  }

  readBytes() {
    const length = this.readVarint();
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error("迁移数据长度无效");
    const value = this.bytes.slice(this.offset, end);
    this.offset = end;
    return value;
  }

  readString() {
    return new TextDecoder().decode(this.readBytes());
  }

  skip(wireType: number) {
    if (wireType === 0) {
      this.readVarint();
      return;
    }
    if (wireType === 1) {
      this.offset += 8;
      return;
    }
    if (wireType === 2) {
      this.readBytes();
      return;
    }
    if (wireType === 5) {
      this.offset += 4;
      return;
    }
    throw new Error(`不支持的迁移字段类型: ${wireType}`);
  }
}

function base64ToBytes(value: string) {
  const normalized = value
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase32(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

function extractMigrationData(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请先粘贴 Google Authenticator 导出的迁移串");

  if (!trimmed.startsWith("otpauth-migration://")) {
    return trimmed;
  }

  const match = /[?&]data=([^&]+)/.exec(trimmed);
  if (!match) throw new Error("迁移串里没有 data 参数");

  return decodeURIComponent(match[1]);
}

function parseOtpParameter(bytes: Uint8Array): OtpParameter {
  const reader = new ProtoReader(bytes);
  const parameter: OtpParameter = {};

  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === 2) parameter.secret = reader.readBytes();
    else if (field === 2 && wireType === 2) parameter.name = reader.readString();
    else if (field === 3 && wireType === 2) parameter.issuer = reader.readString();
    else if (field === 4 && wireType === 0) parameter.algorithm = reader.readVarint();
    else if (field === 5 && wireType === 0) parameter.digits = reader.readVarint();
    else if (field === 6 && wireType === 0) parameter.type = reader.readVarint();
    else reader.skip(wireType);
  }

  return parameter;
}

function parseMigrationPayload(bytes: Uint8Array): MigrationPayload {
  const reader = new ProtoReader(bytes);
  const payload: MigrationPayload = { otpParameters: [] };

  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === 2) payload.otpParameters.push(parseOtpParameter(reader.readBytes()));
    else if (field === 3 && wireType === 0) payload.batchSize = reader.readVarint();
    else if (field === 4 && wireType === 0) payload.batchIndex = reader.readVarint();
    else reader.skip(wireType);
  }

  return payload;
}

function parseLabel(name = "", issuer = "") {
  const cleanName = name.trim();
  let cleanIssuer = issuer.trim();
  let account = cleanName;

  const separatorIndex = cleanName.indexOf(":");
  if (separatorIndex >= 0) {
    const prefix = cleanName.slice(0, separatorIndex).trim();
    const suffix = cleanName.slice(separatorIndex + 1).trim();
    if (!cleanIssuer) cleanIssuer = prefix;
    account = suffix;
  }

  if (!cleanIssuer) cleanIssuer = account || "Google Authenticator";
  if (account === cleanIssuer) account = "";

  return {
    issuer: cleanIssuer,
    account,
  };
}

function mapAlgorithm(value?: number): GoogleAlgorithm | null {
  if (!value || value === 1) return "SHA1";
  if (value === 2) return "SHA256";
  if (value === 3) return "SHA512";
  return null;
}

function mapDigits(value?: number): 6 | 8 {
  return value === 2 ? 8 : 6;
}

export function parseGoogleAuthenticatorMigration(input: string): GoogleAuthenticatorImportResult {
  const payload = parseMigrationPayload(base64ToBytes(extractMigrationData(input)));
  const entries: TOTPEntry[] = [];
  const skipped: string[] = [];
  const now = Date.now();

  payload.otpParameters.forEach((parameter, index) => {
    const label = parameter.name?.trim() || `第 ${index + 1} 个账号`;
    if (!parameter.secret || parameter.secret.length === 0) {
      skipped.push(`${label}: 缺少 secret`);
      return;
    }
    if (parameter.type && parameter.type !== 2) {
      skipped.push(`${label}: HOTP 计数器账号暂不支持`);
      return;
    }

    const algorithm = mapAlgorithm(parameter.algorithm);
    if (!algorithm) {
      skipped.push(`${label}: 不支持的算法`);
      return;
    }

    const { issuer, account } = parseLabel(parameter.name, parameter.issuer);
    entries.push({
      id: `google-auth-${now}-${index}`,
      issuer,
      account,
      secret: bytesToBase32(parameter.secret),
      algorithm,
      digits: mapDigits(parameter.digits),
      period: 30,
      note: "Google Authenticator 导入",
      createdAt: now,
    });
  });

  const batchHint = payload.batchSize && payload.batchSize > 1 && typeof payload.batchIndex === "number"
    ? `这是第 ${payload.batchIndex + 1}/${payload.batchSize} 张迁移二维码，其他二维码也需要继续导入。`
    : undefined;

  return { entries, skipped, batchHint };
}
