import { apiFetch, BASE } from "./client.js";

export const botsApi = {
  /* Dashboard data */
  dashboard:       ()                       => apiFetch("/bots/dashboard"),

  /* Bot lifecycle */
  deploy:          (body)                   => apiFetch("/bots/deploy",          { method: "POST",   body: JSON.stringify(body) }),
  patch:           (id, body)               => apiFetch(`/bots/${id}`,           { method: "PATCH",  body: JSON.stringify(body) }),
  remove:          (id)                     => apiFetch(`/bots/${id}`,           { method: "DELETE" }),

  /* QR / SSE */
  qr:              (id)                     => apiFetch(`/bots/${id}/qr`),
  groups:          (id)                     => apiFetch(`/bots/${id}/groups`),
  createPairingCode: (id, phone)            => apiFetch(`/bots/${id}/request-pairing`, { method: "POST", body: JSON.stringify({ phone }) }),
  getPairingCode:    (id, code)             => apiFetch(`/bots/${id}/pairing-code/${code}`),
  claimPairingCode:  (id, code, session)    => apiFetch(`/bots/${id}/pairing-code/${code}/claim`, { method: "POST", body: JSON.stringify({ session_data: session }) }),
  eventsUrl:       (id, token) => {
    return `${BASE}/bots/${id}/events?token=${encodeURIComponent(token || "")}`;
  },

  /* Reconnect a disconnected / failed bot */
  reconnect:       (id)                     => apiFetch(`/bots/${id}/reconnect`, { method: "POST" }),

  /* Send DM from dashboard */
  sendDM:          (id, payload)            => apiFetch(`/bots/${id}/send`,      { method: "POST",   body: JSON.stringify(payload) }),

  /* AI config (Pro) */
  saveAiConfig:    (id, aiConfig)           => apiFetch(`/bots/${id}`,           { method: "PATCH",  body: JSON.stringify({ ai_config: aiConfig }) }),

  /* Commands config */
  saveCommands:    (id, commandsConfig)     => apiFetch(`/bots/${id}`,           { method: "PATCH",  body: JSON.stringify({ commands_config: commandsConfig }) }),

  /* v1 Developer API */
  v1Me:            ()                       => apiFetch("/v1/me"),
  v1Bots:          ()                       => apiFetch("/v1/bots"),
  v1Bot:           (id)                     => apiFetch(`/v1/bots/${id}`),
  v1SendMessage:   (botId, to, msg)         => apiFetch("/v1/messages/send",     { method: "POST",   body: JSON.stringify({ bot_id: botId, to, message: msg }) }),
  v1Conversations: (botId, limit, offset)   => apiFetch(`/v1/conversations?bot_id=${botId || ""}&limit=${limit || 50}&offset=${offset || 0}`),
  v1Activity:      (botId, limit)           => apiFetch(`/v1/activity?bot_id=${botId || ""}&limit=${limit || 100}`),
  v1TestWebhook:   (url, secret)            => apiFetch("/v1/webhooks/test",     { method: "POST",   body: JSON.stringify({ url, secret }) }),
  v1MarkConversationsRead: (activityIds)    => apiFetch("/v1/conversations/mark-read", { method: "POST", body: JSON.stringify({ activity_ids: activityIds }) }),
};
