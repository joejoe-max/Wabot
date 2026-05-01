import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

const PLACEHOLDER_URL = "https://placeholder.supabase.co";
const PLACEHOLDER_KEY = "placeholder-key";

export const supabase = createClient(
  env.supabaseUrl  || PLACEHOLDER_URL,
  env.supabaseServiceRoleKey || PLACEHOLDER_KEY,
  { auth: { persistSession: false } }
);
