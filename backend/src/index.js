import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import hpp from "hpp";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import authRouter    from "./routes/auth.js";
import botRouter     from "./routes/bots.js";
import billingRouter from "./routes/billing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, "../../frontend/dist");
const IS_PROD = env.nodeEnv === "production";

const app = express();

/* ── Trust proxy (Replit / reverse-proxy environments) ── */
app.set("trust proxy", 1);

/* ── Security headers ── */
app.disable("x-powered-by");
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: IS_PROD
    ? {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc:  ["'self'", "'unsafe-inline'"],
          styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc:    ["'self'", "https://fonts.gstatic.com"],
          imgSrc:     ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"]
        }
      }
    : false
}));

/* ── Compression ── */
app.use(compression());

/* ── HTTP parameter pollution ── */
app.use(hpp());

/* ── CORS (dev only — in prod the API is same-origin) ── */
if (!IS_PROD) {
  const allowedOrigins = env.allowedOrigins.split(",").map((o) => o.trim()).filter(Boolean);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true
  }));
}

/* ── Rate limiting ── */
app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 20 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." }
}));

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  max: IS_PROD ? 100 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." }
}));

/* ── Body parsing (skip for Stripe raw webhook) ── */
app.use((req, res, next) => {
  if (req.originalUrl === "/api/billing/webhook") return next();
  return express.json({ limit: "100kb" })(req, res, next);
});

/* ── Health ── */
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "wabot-api", env: env.nodeEnv, configured: { jwt: env.hasJwt, supabase: env.hasSupabase, email: env.hasBrevo, stripe: env.hasStripe } }));

/* ── API Routes ── */
app.use("/api/auth",    authRouter);
app.use("/api/bots",    botRouter);
app.use("/api/billing", billingRouter);

/* ── Serve frontend in production ── */
if (IS_PROD) {
  app.use(express.static(FRONTEND_DIST, {
    maxAge: "1y",
    immutable: true,
    index: false
  }));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, "index.html"));
  });
} else {
  app.use((_req, res) => res.status(404).json({ error: "Not found." }));
}

/* ── Global error handler ── */
app.use((err, _req, res, _next) => {
  console.error("[error]", err.message);
  return res.status(500).json({
    error: IS_PROD ? "Internal server error." : err.message
  });
});

const PORT = IS_PROD ? 5000 : env.port;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ WaBot API running on http://0.0.0.0:${PORT} [${env.nodeEnv}]`);
});
