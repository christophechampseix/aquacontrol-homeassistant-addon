#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';

const CONFIG_PATH = '/data/options.json';
const MDNS_HOST = 'eheimdigital.local';
const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 15000;
const DEVICE_TIMEOUT_MS = 8000;

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const config = await readConfig();

const SUPABASE_URL = config.aquacontrol_url;
const SUPABASE_KEY = config.supabase_key;
const AGENT_ID = config.bridge_id;
const AGENT_TOKEN = config.bridge_token;

if (!SUPABASE_URL || !SUPABASE_KEY || !AGENT_ID || !AGENT_TOKEN) {
  console.error('Config ontbreekt. Vul aquacontrol_url, supabase_key, bridge_id en bridge_token in.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: {
    headers: {
      'x-agent-id': AGENT_ID,
      'x-agent-token': AGENT_TOKEN,
    },
  },
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildBasicAuth(username, password) {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

async function deviceFetch(host, path, method = 'GET', username = 'api', password = 'admin', body = undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEVICE_TIMEOUT_MS);

  try {
    const opts = {
      method,
      headers: {
        Authorization: `Basic ${buildBasicAuth(username, password)}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    };

    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`http://${host}${path}`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function updateCommand(commandId, patch) {
  const { error } = await supabase
    .from('bridge_commands')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', commandId);

  if (error) console.error(`[bridge] command update error (${commandId}):`, error.message);
}

async function handleRequest(command) {
  const payload = command.payload ?? {};
  const { host, path, method = 'GET', username = 'api', password = 'admin', body } = payload;

  if (!host || !path) {
    await updateCommand(command.id, { status: 'error', error: 'host/path ontbreekt in command payload' });
    return;
  }

  try {
    console.log(`[bridge] ${method} http://${host}${path} (id=${command.id})`);
    const data = await deviceFetch(host, path, method, username, password, body);
    await updateCommand(command.id, { status: 'done', result: data });
  } catch (err) {
    await updateCommand(command.id, { status: 'error', error: err.message });
  }
}

function resolveMdns(hostname, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const name = hostname.endsWith('.') ? hostname : `${hostname}.`;
    const labels = name.split('.').filter(Boolean);
    const parts = [];

    for (const label of labels) {
      const buf = Buffer.from(label, 'utf8');
      parts.push(Buffer.from([buf.length]), buf);
    }
    parts.push(Buffer.from([0]));

    const qname = Buffer.concat(parts);
    const header = Buffer.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const query = Buffer.concat([header, qname, Buffer.from([0x00, 0x01]), Buffer.from([0x00, 0x01])]);
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    let timer;

    sock.on('message', (msg) => {
      try {
        let offset = 12;
        const qdcount = msg.readUInt16BE(4);

        for (let i = 0; i < qdcount && offset < msg.length; i++) {
          while (offset < msg.length && msg[offset] !== 0) {
            if ((msg[offset] & 0xc0) === 0xc0) { offset += 2; break; }
            offset += msg[offset] + 1;
          }
          if (msg[offset] === 0) offset++;
          offset += 4;
        }

        const ancount = msg.readUInt16BE(6);
        for (let i = 0; i < ancount && offset < msg.length; i++) {
          while (offset < msg.length && msg[offset] !== 0) {
            if ((msg[offset] & 0xc0) === 0xc0) { offset += 2; break; }
            offset += msg[offset] + 1;
          }
          if (offset < msg.length && msg[offset] === 0) offset++;
          const rtype = msg.readUInt16BE(offset); offset += 2;
          offset += 6;
          const rdlen = msg.readUInt16BE(offset); offset += 2;

          if (rtype === 1 && rdlen === 4) {
            found.add(`${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`);
          }
          offset += rdlen;
        }
      } catch {}
    });

    sock.on('error', () => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(found.size > 0 ? [...found][0] : null);
    });

    sock.bind(0, () => {
      try { sock.addMembership('224.0.0.251'); } catch {}
      sock.send(query, 0, query.length, 5353, '224.0.0.251');
      timer = setTimeout(() => {
        try { sock.close(); } catch {}
        resolve(found.size > 0 ? [...found][0] : null);
      }, timeoutMs);
    });
  });
}

async function resolveEheimHost() {
  console.log(`[bridge] Stap 1: DNS lookup ${MDNS_HOST}`);
  try {
    const addresses = await dns.lookup(MDNS_HOST, { all: true });
    for (const entry of addresses) {
      try {
        await deviceFetch(entry.address, '/api/userdata', 'GET', 'api', 'admin');
        console.log(`[bridge] EHEIM bereikbaar via DNS: ${entry.address}`);
        return entry.address;
      } catch (err) {
        console.log(`[bridge] DNS adres ${entry.address} niet bruikbaar: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`[bridge] DNS lookup mislukt: ${err.message}`);
  }

  console.log(`[bridge] Stap 2: hostname fetch ${MDNS_HOST}`);
  try {
    await deviceFetch(MDNS_HOST, '/api/userdata', 'GET', 'api', 'admin');
    console.log('[bridge] EHEIM bereikbaar via hostname');
    return MDNS_HOST;
  } catch (err) {
    console.log(`[bridge] Hostname fetch mislukt: ${err.message}`);
  }

  console.log('[bridge] Stap 3: mDNS UDP multicast');
  const ip = await resolveMdns(MDNS_HOST, 6000);
  if (ip) {
    console.log(`[bridge] EHEIM gevonden via mDNS: ${ip}`);
    return ip;
  }

  throw new Error('eheimdigital.local niet bereikbaar via DNS, hostname of mDNS UDP');
}

async function handleDiscover(command) {
  const { username = 'api', password = 'admin' } = command.payload ?? {};
  console.log(`[bridge] Discovery gestart (id=${command.id})`);

  try {
    const masterHost = await resolveEheimHost();
    const masterData = await deviceFetch(masterHost, '/api/userdata', 'GET', username, password);
    const masterMac = masterData.macAddress ?? masterData.mac ?? '';

    const devices = [{
      mac: masterMac,
      name: masterData.name?.trim() || 'EHEIM Digital',
      type: masterData.productName || 'EheimDigital',
      isMaster: true,
      ip: masterHost,
      isOnline: true,
    }];

    let deviceList = null;
    try {
      deviceList = await deviceFetch(masterHost, '/api/devicelist', 'GET', username, password);
    } catch (err) {
      console.log(`[bridge] /api/devicelist niet beschikbaar: ${err.message}`);
    }

    if (deviceList?.clientList?.length > 0) {
      const meshEntries = deviceList.clientList.map((mac, index) => ({
        mac,
        ip: deviceList.clientIPList?.[index] ?? '',
      }));

      const results = await Promise.allSettled(
        meshEntries
          .filter(entry => entry.mac?.toLowerCase() !== masterMac?.toLowerCase())
          .map(async (entry) => {
            if (!entry.ip) {
              return {
                mac: entry.mac,
                name: 'EHEIM Digital',
                type: 'EheimDigital',
                isMaster: false,
                ip: '',
                isOnline: false,
              };
            }

            try {
              const userdata = await deviceFetch(entry.ip, '/api/userdata', 'GET', username, password);
              return {
                mac: userdata.macAddress ?? userdata.mac ?? entry.mac,
                name: userdata.name?.trim() || 'EHEIM Digital',
                type: userdata.productName || 'EheimDigital',
                isMaster: false,
                ip: entry.ip,
                isOnline: true,
              };
            } catch {
              return {
                mac: entry.mac,
                name: 'EHEIM Digital',
                type: 'EheimDigital',
                isMaster: false,
                ip: entry.ip,
                isOnline: false,
              };
            }
          })
      );

      const seenMacs = new Set(devices.map(device => device.mac?.toLowerCase()).filter(Boolean));
      const seenIps = new Set(devices.map(device => device.ip?.toLowerCase()).filter(Boolean));

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const device = result.value;
        if (device.mac && seenMacs.has(device.mac.toLowerCase())) continue;
        if (device.ip && seenIps.has(device.ip.toLowerCase())) continue;
        devices.push(device);
        if (device.mac) seenMacs.add(device.mac.toLowerCase());
        if (device.ip) seenIps.add(device.ip.toLowerCase());
      }
    }

    console.log(`[bridge] Discovery klaar: ${devices.length} apparaat/apparaten`);
    await updateCommand(command.id, { status: 'done', result: { devices } });
  } catch (err) {
    console.log(`[bridge] Discovery fout: ${err.message}`);
    await updateCommand(command.id, { status: 'error', error: err.message });
  }
}

async function heartbeat() {
  const { error } = await supabase
    .from('bridge_agents')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', AGENT_ID);

  if (error) console.error('[bridge] heartbeat error:', error.message);
}

async function poll() {
  const { data: rows, error } = await supabase
    .from('bridge_commands')
    .select('*')
    .eq('agent_id', AGENT_ID)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(5);

  if (error) {
    console.error('[bridge] poll error:', error.message);
    return;
  }

  if (!rows?.length) return;

  for (const command of rows) {
    const { data: claimed } = await supabase
      .from('bridge_commands')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', command.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (!claimed) continue;

    if (command.type === 'discover') {
      void handleDiscover(command);
    } else {
      void handleRequest(command);
    }
  }
}

let lastHeartbeat = 0;

async function loop() {
  while (true) {
    try {
      await poll();

      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeat = now;
        await heartbeat();
      }
    } catch (err) {
      console.error('[bridge] loop error:', err.message);
    }

    await wait(POLL_INTERVAL_MS);
  }
}

console.log(`[bridge] AquaControl HA Bridge gestart. ID=${AGENT_ID}`);
console.log(`[bridge] Verbonden met: ${SUPABASE_URL}`);
await heartbeat();
await loop();
