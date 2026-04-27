export async function fetchCommandsWithFallback(apiRequest, bridgeId) {
  try {
    const data = await apiRequest(`/commands?bridge_id=${encodeURIComponent(bridgeId)}`, {
      method: 'GET',
    });
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.commands)) return data.commands;
    return [];
  } catch (err) {
    if (err?.status !== 405 && !String(err?.message || '').includes('Method not allowed')) {
      throw err;
    }
  }

  const data = await apiRequest('/commands', {
    method: 'POST',
    body: { bridge_id: bridgeId },
  });
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.commands)) return data.commands;
  return [];
}
