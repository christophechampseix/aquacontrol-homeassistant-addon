#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import { createApiClient } from './api-client.js';

const CONFIG_PATH = '/data/options.json';
const DEFAULT_API_URL = 'https://aquacontrol.champseix.be/api';
const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 15000;
const DEVICE_TIMEOUT_MS = 8000;

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const config = await readConfig();
const AQUACONTROL_URL = String(config.aquacontrol_url || DEFAULT_API_URL).replace(/\/$/, '');
const BRIDGE_ID = config.bridge_id || 'homeassistant-green';
const BRIDGE_TOKEN = config.bridge_token;

if (!BRIDGE_TOKEN) {
  console.error('[bridge] bridge_token ontbreekt.');
  process.exit(1);
}

const api = createApiClient({ baseUrl: AQUACONTROL_URL, bridgeId: BRIDGE_ID, bridgeToken: BRIDGE_TOKEN });

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function auth(u, p) { return Buffer.from(`${u}:${p}`).toString('base64'); }

function isAllowedHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'eheimdigital.local' || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(value) || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) || /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(value);
}

function isAllowedPath(path) {
  const value = String(path || '');
  return value.startsWith('/api/') && !value.includes('..') && !value.includes('://');
}

async function deviceFetch({ host, path, method = 'GET', username = 'api', password = 'admin', body }) {
  if (!isAllowedHost(host)) throw new Error('host niet toegelaten');
  if (!isAllowedPath(path)) throw new Error('path niet toegelaten');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEVICE_TIMEOUT_MS);
  try {
    const opts = { method, headers: { Authorization: `Basic ${auth(username, password)}`, 'Content-Type': 'application/json' }, signal: controller.signal, redirect: 'error' };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const res = await fetch(`http://${host}${path}`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function report(commandId, patch) {
  try { await api.result(commandId, patch); }
  catch (err) { console.error('[bridge] result update error:', err.message); }
}

async function handleRequest(command) {
  try {
    const data = await deviceFetch(command.payload || {});
    await report(command.id, { status: 'done', result: data });
  } catch (err) {
    await report(command.id, { status: 'error', error: err.message });
  }
}

async function handleDiscover(command) {
  try {
    const data = await deviceFetch({ host: 'eheimdigital.local', path: '/api/userdata', username: command.payload?.username || 'api', password: command.payload?.password || 'admin' });
    await report(command.id, { status: 'done', result: { devices: [{ ...data, ip: 'eheimdigital.local', isOnline: true }] } });
  } catch (err) {
    await report(command.id, { status: 'error', error: err.message });
  }
}

async function heartbeat() {
  try { await api.heartbeat({ bridge_id: BRIDGE_ID, source: 'home-assistant-addon', hostname: os.hostname(), version: '1.2.0', timestamp: new Date().toISOString() }); }
  catch (err) { console.error('[bridge] heartbeat error:', err.message); }
}

async function poll() {
  try {
    const commands = await api.commands();
    for (const command of commands) {
      if (!command?.id) continue;
      if (!(await api.claim(command.id))) continue;
      if (command.type === 'discover') void handleDiscover(command);
      else void handleRequest(command);
    }
  } catch (err) {
    console.error('[bridge] poll error:', err.message);
  }
}

console.log(`[bridge] AquaControl HA Bridge gestart. ID=${BRIDGE_ID}`);
console.log(`[bridge] API: ${AQUACONTROL_URL}`);
let lastHeartbeat = 0;
while (true) {
  await poll();
  const now = Date.now();
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) { lastHeartbeat = now; await heartbeat(); }
  await wait(POLL_INTERVAL_MS);
}
