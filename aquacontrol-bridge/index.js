#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';

const CONFIG_PATH = '/data/options.json';

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
  console.error('Config ontbreekt');
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

async function heartbeat() {
  await supabase
    .from('bridge_agents')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', AGENT_ID);
}

async function poll() {
  const { data } = await supabase
    .from('bridge_commands')
    .select('*')
    .eq('agent_id', AGENT_ID)
    .eq('status', 'pending')
    .limit(5);

  if (!data) return;

  for (const cmd of data) {
    await supabase
      .from('bridge_commands')
      .update({ status: 'processing' })
      .eq('id', cmd.id);

    try {
      const res = await fetch(`http://${cmd.payload.host}${cmd.payload.path}`);
      const json = await res.json();

      await supabase
        .from('bridge_commands')
        .update({ status: 'done', result: json })
        .eq('id', cmd.id);
    } catch (e) {
      await supabase
        .from('bridge_commands')
        .update({ status: 'error', error: e.message })
        .eq('id', cmd.id);
    }
  }
}

async function loop() {
  while (true) {
    await poll();
    await heartbeat();
    await new Promise(r => setTimeout(r, 2000));
  }
}

console.log('AquaControl HA Bridge gestart');
loop();
