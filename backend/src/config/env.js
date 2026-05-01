import "dotenv/config";

const IS_PROD = process.env.NODE_ENV === "production";

function get(name, fallback = "") {
  return process.env[name] || fallback;
}

function requireOrWarn(name) {
  const value = process.env[name];
  if (!value) {
    if (IS_PROD) throw new Error(`Missing required env var: ${name}. See backend/.env.example`);
    console.warn(`[config] ⚠  ${name} is not set — related features will be unavailable.`);
  }
  return value || "";
}

export const env = {
  port:     Number(process.env.PORT || 3000),
  nodeEnv:  get("NODE_ENV", "development"),
  isProd:   IS_PROD,

  jwtSecret:              requireOrWarn("JWT_SECRET"),
  appBaseUrl:             get("APP_BASE_URL", "http://localhost:5000"),
  apiBaseUrl:             get("API_BASE_URL", "http://localhost:3000"),
  allowedOrigins:         get("ALLOWED_ORIGINS", "http://localhost:5000"),

  supabaseUrl:            requireOrWarn("SUPABASE_URL"),
  supabaseServiceRoleKey: requireOrWarn("SUPABASE_SERVICE_ROLE_KEY"),

  brevoApiKey:       get("BREVO_API_KEY"),
  brevoSenderEmail:  get("BREVO_SENDER_EMAIL"),
  brevoSenderName:   get("BREVO_SENDER_NAME", "WaBot"),

  stripeSecretKey:     get("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: get("STRIPE_WEBHOOK_SECRET"),
  stripePriceIdGrowth: get("STRIPE_PRICE_ID_GROWTH"),

  get hasJwt()    { return Boolean(this.jwtSecret); },
  get hasSupabase(){ return Boolean(this.supabaseUrl && this.supabaseServiceRoleKey); },
  get hasBrevo()  { return Boolean(this.brevoApiKey && this.brevoSenderEmail); },
  get hasStripe() { return Boolean(this.stripeSecretKey); },
};
