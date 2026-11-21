'use strict';
// Encrypted, owner-only account store for the HaksterAI mail client.
// Credentials never leave this file unencrypted and are never sent to the browser.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAIL_DIR = path.join(os.homedir(), '.hakster', 'mail');
const KEY_FILE = path.join(MAIL_DIR, '.key');
const STORE_FILE = path.join(MAIL_DIR, 'accounts.json');

function ensureDir() {
  if (!fs.existsSync(MAIL_DIR)) {
    fs.mkdirSync(MAIL_DIR, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(MAIL_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Mail storage directory is unsafe');
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(MAIL_DIR, 0o700);
}

function key() {
  ensureDir();
  if (fs.existsSync(KEY_FILE)) {
    const stat = fs.lstatSync(KEY_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Mail key file is unsafe');
    const buf = fs.readFileSync(KEY_FILE);
    if (buf.length !== 32) throw new Error('Mail key file is corrupt');
    return buf;
  }
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, buf, { mode: 0o600, flag: 'wx' });
  return buf;
}

function encrypt(plainObject) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(plainObject), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}

function decrypt(envelope) {
  if (!envelope || envelope.version !== 1) throw new Error('Unsupported mail store format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function readStore() {
  if (!fs.existsSync(STORE_FILE)) return { version: 1, accounts: [] };
  const stat = fs.lstatSync(STORE_FILE);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Mail store file is unsafe');
  const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const payload = decrypt(parsed);
  if (!Array.isArray(payload.accounts)) throw new Error('Mail store is corrupt');
  return payload;
}

function writeStore(payload) {
  ensureDir();
  if (fs.existsSync(STORE_FILE)) {
    const stat = fs.lstatSync(STORE_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Mail store file is unsafe');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${STORE_FILE}.bak-${stamp}`;
    const original = crypto.createHash('sha256').update(fs.readFileSync(STORE_FILE)).digest('hex');
    fs.copyFileSync(STORE_FILE, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
    const copied = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
    if (copied !== original) throw new Error('Mail store backup verification failed');
  }
  const tmp = `${STORE_FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(encrypt(payload), null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, STORE_FILE);
  fs.chmodSync(STORE_FILE, 0o600);
}

function ownerKey(userId) {
  return crypto.createHash('sha256').update('mail:' + String(userId || '')).digest('hex');
}

function listAccounts(userId) {
  const store = readStore();
  const mine = (store.accounts || []).filter((a) => a.ownerKey === ownerKey(userId));
  return mine.map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    email: a.email,
    status: a.status || 'unknown',
    addedAt: a.addedAt || '',
    lastCheckedAt: a.lastCheckedAt || '',
  }));
}

function getAccount(userId, id) {
  const store = readStore();
  const found = (store.accounts || []).find((a) => a.id === id && a.ownerKey === ownerKey(userId));
  return found || null;
}

function addAccount(userId, account) {
  const store = readStore();
  const id = 'acc_' + crypto.randomBytes(8).toString('hex');
  const record = { ...account, id, ownerKey: ownerKey(userId), addedAt: new Date().toISOString() };
  store.accounts.push(record);
  writeStore(store);
  return { id, label: record.label, kind: record.kind, email: record.email };
}

function updateAccount(userId, id, patch) {
  const store = readStore();
  const index = (store.accounts || []).findIndex((a) => a.id === id && a.ownerKey === ownerKey(userId));
  if (index === -1) return null;
  store.accounts[index] = { ...store.accounts[index], ...patch };
  writeStore(store);
  return store.accounts[index];
}

function removeAccount(userId, id) {
  const store = readStore();
  const index = (store.accounts || []).findIndex((a) => a.id === id && a.ownerKey === ownerKey(userId));
  if (index === -1) return false;
  // No destructive delete: the record is moved to a dated archive inside the store file,
  // and writeStore keeps a full timestamped backup of the previous contents.
  store.archived = store.archived || [];
  store.archived.push({ ...store.accounts[index], archivedAt: new Date().toISOString() });
  store.accounts.splice(index, 1);
  writeStore(store);
  return true;
}

module.exports = { listAccounts, getAccount, addAccount, updateAccount, removeAccount, MAIL_DIR };
