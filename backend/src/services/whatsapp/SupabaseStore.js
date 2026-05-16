/**
 * SupabaseStore — Custom Baileys auth state backed by Supabase.
 * Saves WhatsApp credentials + Signal keys so bots survive server restarts
 * without requiring a new QR scan.
 *
 * Key writes are debounced (4 s) so rapid Signal key updates during active
 * messaging are coalesced into a single upsert rather than flooding Supabase.
 * Credential writes (saveCreds) are always immediate.
 */

import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { supabase } from "../../lib/supabase.js";

/**
 * Creates a Baileys-compatible auth state that persists in Supabase.
 * @param {string} botId - UUID of the bot
 * @returns {{ state: AuthenticationState, saveCreds: Function }}
 */
export async function createSupabaseAuthState(botId) {
  const { data } = await supabase
    .from("bot_sessions")
    .select("creds, keys")
    .eq("bot_id", botId)
    .maybeSingle();

  // Deserialize stored creds using Baileys' BufferJSON reviver
  let creds;
  try {
    creds = data?.creds
      ? JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver)
      : initAuthCreds();
  } catch {
    creds = initAuthCreds();
  }

  // In-memory key cache — flushed to Supabase on a debounced schedule
  let keysCache = {};
  try {
    if (data?.keys) {
      const raw = JSON.stringify(data.keys);
      keysCache = JSON.parse(raw, BufferJSON.reviver);
    }
  } catch {
    keysCache = {};
  }

  /* Persist both creds and keys in a single upsert */
  const saveAll = async () => {
    try {
      const credsJson = JSON.parse(JSON.stringify(creds,     BufferJSON.replacer));
      const keysJson  = JSON.parse(JSON.stringify(keysCache, BufferJSON.replacer));
      await supabase.from("bot_sessions").upsert(
        { bot_id: botId, creds: credsJson, keys: keysJson, updated_at: new Date().toISOString() },
        { onConflict: "bot_id" }
      );
    } catch (err) {
      console.error("[SupabaseStore] save failed:", err.message);
    }
  };

  /*
   * Debounced save for Signal key writes.
   * Baileys can fire keys.set() dozens of times per second during encryption
   * handshakes and message processing.  We accumulate all changes in-memory
   * and only flush to Supabase once the burst has settled (4 s silence).
   */
  let _debounceTimer = null;
  const scheduleSave = () => {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      saveAll().catch(() => {});
    }, 4_000);
  };

  const state = {
    creds,
    keys: {
      /** Retrieve Signal keys by type+id pairs */
      get: async (type, ids) => {
        const result = {};
        for (const id of ids) {
          const k = `${type}:${id}`;
          if (keysCache[k] !== undefined) result[id] = keysCache[k];
        }
        return result;
      },
      /** Write (or delete if null) Signal keys — persisted on debounced schedule */
      set: async (data) => {
        for (const [type, typeData] of Object.entries(data)) {
          if (!typeData) continue;
          for (const [id, value] of Object.entries(typeData)) {
            const k = `${type}:${id}`;
            if (value !== null && value !== undefined) {
              keysCache[k] = value;
            } else {
              delete keysCache[k];
            }
          }
        }
        scheduleSave(); // debounced — no immediate Supabase write
      }
    }
  };

  /* saveCreds is called by Baileys when auth credentials change (QR scan,
     re-registration, etc.) — these must be written immediately so a restart
     immediately after login does not lose the session. */
  return { state, saveCreds: saveAll };
}

/** Delete persisted session so the next connection requires a new QR scan. */
export async function clearSupabaseSession(botId) {
  await supabase.from("bot_sessions").delete().eq("bot_id", botId);
}
