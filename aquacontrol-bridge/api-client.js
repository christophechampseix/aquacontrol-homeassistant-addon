export function createApiClient({ baseUrl, bridgeId, bridgeToken, timeoutMs = 10000 }) {
  const apiBase = String(baseUrl || '').replace(/\/$/, '');

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${apiBase}/bridge-api${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bridgeToken}`,
          'x-bridge-id': bridgeId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(data?.error || data?.message || `API HTTP ${response.status}`);
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    heartbeat(payload) {
      return request('/heartbeat', { method: 'POST', body: payload });
    },

    async commands() {
      const data = await request(`/commands?bridge_id=${encodeURIComponent(bridgeId)}`);
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.commands)) return data.commands;
      return [];
    },

    async claim(commandId) {
      const data = await request(`/commands/${encodeURIComponent(commandId)}/claim`, {
        method: 'POST',
        body: { bridge_id: bridgeId },
      });
      return data?.claimed !== false;
    },

    result(commandId, patch) {
      return request(`/commands/${encodeURIComponent(commandId)}/result`, {
        method: 'POST',
        body: { bridge_id: bridgeId, ...patch },
      });
    },
  };
}
