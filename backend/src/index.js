import express         from "express";
import cors            from "cors";
import helmet          from "helmet";
import compression     from "compression";
import hpp             from "hpp";
import path            from "node:path";
import { fileURLToPath } from "node:url";

import { env }         from "./config/env.js";
import { logger }      from "./utils/logger.js";
import { apiLimiter }  from "./middleware/rateLimiter.js";
import { botManager }  from "./services/whatsapp/BotManager.js";
import { dashboardRealtime } from "./services/realtime/DashboardRealtime.js";
import authRouter      from "./routes/auth.js";
import botRouter       from "./routes/bots.js";
import billingRouter   from "./routes/billing.js";
import v1Router        from "./routes/v1.js";
import adminRouter     from "./routes/admin.js";

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, "../../frontend/dist");
const IS_PROD       = env.isProd;

/* ── App ──────────────────────────────────────────────────────── */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

/* ── Security headers ─────────────────────────────────────────── */
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: IS_PROD ? {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "blob:"],
      connectSrc:  ["'self'", ...env.allowedOrigins.split(",").map(o => o.trim()).filter(Boolean)]
    }
  } : false
}));

app.use(compression());
app.use(hpp());

/* ── CORS — always enabled (frontend can be on a separate server) */
const allowedOrigins = env.allowedOrigins.split(",").map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes("*")) return cb(null, true);
    if (allowedOrigins.some((o) => origin === o || origin.endsWith(o.replace(/^https?:\/\//, "")))) {
      return cb(null, true);
    }
    if (!IS_PROD && (
      origin.includes("localhost") ||
      origin.includes("127.0.0.1") ||
      origin.includes(".replit.dev") ||
      origin.includes(".repl.co")
    )) return cb(null, true);
    logger.warn({ origin }, "CORS blocked origin");
    cb(new Error(`Origin not allowed: ${origin}`));
  },
  credentials:    true,
  methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining"],
  maxAge:         600
}));

/* ── Body parsing (bypass for Paystack raw webhook — needs raw body for HMAC) */
app.use((req, res, next) => {
  if (req.originalUrl === "/api/billing/webhook") return next();
  express.json({ limit: "256kb" })(req, res, next);
});

/* ── General rate limit ───────────────────────────────────────── */
app.use("/api", apiLimiter);

/* ── Health ───────────────────────────────────────────────────── */
function sendHealth(_req, res) {
  return res.json({
    ok:      true,
    service: "wabot-api",
    env:     env.nodeEnv,
    ts:      Date.now(),
    configured: {
      jwt:          env.hasJwt,
      supabase:     env.hasSupabase,
      email:        env.hasBrevo,
      paystack:     env.hasPaystack,
      superadmin:   env.hasSuperadmin
    }
  });
}

app.get("/health", sendHealth);
app.get("/api/health", sendHealth);

/* ── API Routes ───────────────────────────────────────────────── */
app.use("/api/auth",    authRouter);
app.use("/api/bots",    botRouter);
app.use("/api/billing", billingRouter);
app.use("/api/v1",      v1Router);
app.use("/api/admin",   adminRouter);

/* ── Serve frontend in production (same-server mode) ─────────── */
if (IS_PROD) {
  app.use(express.static(FRONTEND_DIST, {
    maxAge: "1y", immutable: true, index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    }
  }));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => {
      if (err) res.status(500).send("Application error — frontend not built.");
    });
  });
} else {
  app.use((_req, res) => res.status(404).json({ error: "Route not found." }));
}

/* ── Global error handler ─────────────────────────────────────── */
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith("Origin not allowed"))
    return res.status(403).json({ error: "CORS: origin not allowed." });
  logger.error({ err }, "Unhandled error");
  res.status(err.status || 500).json({
    error: IS_PROD ? "Internal server error." : err.message
  });
});

/* ── Start ────────────────────────────────────────────────────── */
const PORT = Number(process.env.PORT || env.port || 3000);

app.listen(PORT, "0.0.0.0", async () => {
  logger.info(`✓ WaBot API ready on port ${PORT} [${env.nodeEnv}]`);
  logger.info(`✓ CORS origins: ${allowedOrigins.join(", ") || "(all in dev)"}`);
  logger.info(`✓ Superadmin: ${env.hasSuperadmin ? "configured" : "NOT SET — /api/admin disabled"}`);

  if (env.hasSupabase) {
    try {
      await dashboardRealtime.initialize();
      logger.info("✓ Dashboard realtime initialized");
      await botManager.initialize();
      logger.info("✓ BotManager initialized");
    } catch (err) {
      logger.error({ err }, "Startup initialization failed");
    }
  } else {
    logger.warn("Supabase not configured — BotManager skipped");
  }
});
