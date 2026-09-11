// Per-session routing flags shared between the session runtime and the tools it exposes (no import cycle).
const flags = new Map();
export const setSessionFlags = (id, patch) => { flags.set(id, { ...(flags.get(id) || {}), ...patch }); return flags.get(id); };
export const sessionFlags = (id) => flags.get(id) || {};
