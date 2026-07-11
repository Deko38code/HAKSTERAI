'use strict';
/**
 * Device fingerprinting — mirrors scripts/device_fingerprint.py
 * Generates stable device UIDs, session UIDs, and hardware fingerprints.
 */
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEMFILE = path.join(os.homedir(), '.haksterai_uid.json');

function getOSInfo() {
  const sys = os.platform();
  return {
    type: sys === 'browser' ? 'browser' : 'os',
    name: sys,
    release: os.release(),
    version: os.version ? os.version() : 'unknown',
    platform: `${sys} ${os.release()} ${os.arch()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    uptime: os.uptime(),
    cpus: os.cpus().length,
    totalmem: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100,
  };
}

function getMacHash() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          return crypto.createHash('sha256').update(iface.mac).digest('hex');
        }
      }
    }
  } catch {}
  return null;
}

function generateDeviceUID() {
  if (fs.existsSync(MEMFILE)) {
    try { return JSON.parse(fs.readFileSync(MEMFILE, 'utf-8')); } catch {}
  }
  const deviceUID = {
    device_id: uuidv4(),
    created: `${os.platform()}-${os.release()}-${os.arch()}`,
    created_at: new Date().toISOString(),
  };
  try { fs.writeFileSync(MEMFILE, JSON.stringify(deviceUID, null, 2)); } catch {}
  return deviceUID;
}

function sessionUID() {
  return uuidv4();
}

function fingerprint() {
  const osInfo = getOSInfo();
  return {
    device_uid: generateDeviceUID(),
    session_uid: sessionUID(),
    hostname: os.hostname(),
    mac_hash: getMacHash(),
    os: osInfo,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { fingerprint, generateDeviceUID, sessionUID, getOSInfo, getMacHash };