export function createApiClient({ baseUrl, bridgeId, bridgeToken, timeoutMs = 10000 }) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  const apiBase = root.endsWith('/bridge-api') ? root : `${root}/bridge-api`;

  function toErrorMessage(data, status) {
    if (typeof data?.error === 'string') return data.error;
    if (typeof data?.message === 'string') return data.message;
    try {
      return JSON.stringify(data ?? { status });
    } catch {
      return `API HTTP ${status}`;
    }
  }

  async function request(path, { method = 'POST', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${apiBase}${path}`, {
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
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text || null;
      }

      if (!response.ok) {
        throw new Error(toErrorMessage(data, response.status));
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
      const data = await request('/commands', { method: 'POST', body: { bridge_id: bridgeId } });
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
