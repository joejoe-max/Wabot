-- Add conversation_reads table to track per-user read state for bot_activity rows
-- Run this migration against your Supabase/Postgres database.

CREATE TABLE IF NOT EXISTS conversation_reads (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_activity_id uuid NOT NULL REFERENCES bot_activity(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, bot_activity_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_reads_user_id ON conversation_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_reads_bot_activity_id ON conversation_reads(bot_activity_id);
