export type View = 'vault' | 'notes' | 'devtools' | 'pomodoro' | 'bookmarks' | 'totp' | 'snippets' | 'subscriptions';

export interface PasswordEntry {
  id: string;
  title: string;
  username: string;
  passwordEncrypted: string;
  url?: string;
  createdAt: number;
}

export interface NoteEntry {
  id: string;
  title: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BookmarkEntry {
  id: string;
  title: string;
  url: string;
  iconUrl?: string;
  tags: string[];
  groupPath?: string[];
  source?: string;
  description?: string;
  createdAt: number;
}

export interface TOTPEntry {
  id: string;
  issuer: string;
  account: string;
  secret: string;
  algorithm?: "SHA1" | "SHA256" | "SHA512";
  digits?: 6 | 8;
  period?: number;
  groupPath?: string[];
  note?: string;
  tags?: string[];
  createdAt: number;
}

export interface SnippetEntry {
  id: string;
  title: string;
  language: string;
  code: string;
  tags?: string[];
  createdAt: number;
}

export interface FileVaultEntry {
  id: string;
  fileName: string;
  encryptedFileName: string;
  size: number;
  createdAt: number;
}

export interface SubscriptionEntry {
  id: string;
  name: string;
  cost: string;
  cycle: 'monthly' | 'yearly';
  nextDate: string;
}

export interface FocusSessionEntry {
  id: string;
  startedAt: number;
  endedAt: number;
  minutes: number;
}
