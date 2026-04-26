const CONFIG_PATH = '/data/options.json';

async function readConfig() {
  try {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function apiUrl(config, path) {
  return `${String(config.aquacontrol_url ?? '').replace(/\/$/, '')}/bridge-api${path}`;
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json().catch(() => null);
}

async function sendHeartbeat(config) {
  if (!config.aquacontrol_url || !config.bridge_token) {
    console.log('AquaControl URL of bridge token ontbreekt.');
    return;
  }

  await postJson(apiUrl(config, '/heartbeat'), config.bridge_token, {
    bridgeId: config.bridge_id ?? 'homeassistant-green',
    source: 'home-assistant-addon',
    hostname: process.env.HOSTNAME ?? 'homeassistant',
    timestamp: new Date().toISOString(),
  });
}

async function main() {
  const config = await readConfig();
  const intervalMs = config.poll_interval_ms ?? 30000;

  console.log('AquaControl Bridge gestart 🚀');

  while (true) {
    try {
      await sendHeartbeat(config);
    } catch (err) {
      console.error('Fout:', err.message);
    }

    await wait(intervalMs);
  }
}

main();
