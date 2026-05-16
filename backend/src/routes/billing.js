import { Router }      from "express";
import express          from "express";
import crypto           from "node:crypto";
import { env }          from "../config/env.js";
import { paystack }     from "../lib/paystack.js";
import { requireAuth }  from "../middleware/auth.js";
import { supabase }     from "../lib/supabase.js";
import { logger }       from "../utils/logger.js";
import { botManager }   from "../services/whatsapp/BotManager.js";

const billingRouter = Router();

/* ── Guard: return 503 if Paystack is not configured ─────────── */
function requirePaystack(_req, res, next) {
  if (!env.hasPaystack) {
    return res.status(503).json({
      error: "Billing is not configured on this server. Set PAYSTACK_SECRET_KEY to enable paid plans."
    });
  }
  return next();
}

/* ── POST /api/billing/checkout ──────────────────────────────── */
billingRouter.post("/checkout", requireAuth, requirePaystack, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { data: user } = await supabase
      .from("users").select("id, email, plan_tier").eq("id", userId).single();

    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.plan_tier === "paid")
      return res.status(400).json({ error: "You are already on the Pro plan." });

    if (!env.paystackPlanCode)
      return res.status(503).json({ error: "Paystack plan code is not configured. Set PAYSTACK_PLAN_CODE." });

    const txn = await paystack.initializeTransaction({
      email:        user.email,
      amount:       150_000,                 /* ₦1,500 in kobo */
      plan:         env.paystackPlanCode,
      callback_url: `${env.appBaseUrl}/dashboard?billing=success`,
      metadata:     { userId, cancel_action: `${env.appBaseUrl}/dashboard?billing=cancelled` },
    });

    return res.json({ url: txn.authorization_url });
  } catch (err) {
    logger.error({ err: err.message }, "[billing/checkout] error");
    return res.status(500).json({ error: "Could not create checkout session." });
  }
});

/* ── GET /api/billing/status ─────────────────────────────────── */
billingRouter.get("/status", requireAuth, async (req, res) => {
  try {
    if (!env.hasPaystack) {
      return res.json({
        configured: false,
        subscription: null
      });
    }

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("status, plan_tier, current_period_end, paystack_subscription_code, created_at")
      .eq("user_id", req.user.sub)
      .maybeSingle();

    if (!sub) return res.json({ configured: true, subscription: null });

    return res.json({
      configured: true,
      subscription: {
        status:           sub.status,
        planTier:         sub.plan_tier,
        currentPeriodEnd: sub.current_period_end,
        hasSubscription:  Boolean(sub.paystack_subscription_code),
        createdAt:        sub.created_at
      }
    });
  } catch (err) {
    logger.error({ err: err.message }, "[billing/status] error");
    return res.status(500).json({ error: "Could not fetch billing status." });
  }
});

/* ── POST /api/billing/portal ────────────────────────────────── */
/* Returns a Paystack manage-subscription URL so the user can
   update their payment method or cancel through Paystack's UI.  */
billingRouter.post("/portal", requireAuth, requirePaystack, async (req, res) => {
  try {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("paystack_subscription_code")
      .eq("user_id", req.user.sub)
      .maybeSingle();

    if (!sub?.paystack_subscription_code)
      return res.status(404).json({
        error: "No billing account found. Subscribe to a plan first."
      });

    /* Fetch subscription from Paystack to get the email_token for the manage URL */
    const psSub      = await paystack.fetchSubscription(sub.paystack_subscription_code);
    const emailToken = psSub?.email_token;

    if (!emailToken)
      return res.status(500).json({ error: "Could not retrieve subscription management link." });

    return res.json({
      url: `https://paystack.com/manage/subscriptions/${emailToken}`
    });
  } catch (err) {
    logger.error({ err: err.message }, "[billing/portal] error");
    return res.status(500).json({ error: "Could not open subscription management." });
  }
});

/* ── POST /api/billing/cancel ────────────────────────────────── */
/* Immediately cancels the subscription via Paystack API.         */
billingRouter.post("/cancel", requireAuth, requirePaystack, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("paystack_subscription_code, status")
      .eq("user_id", userId)
      .maybeSingle();

    if (!sub?.paystack_subscription_code || sub.status === "canceled")
      return res.status(404).json({ error: "No active subscription found." });

    /* Fetch subscription to get the email_token required by Paystack disable API */
    const psSub = await paystack.fetchSubscription(sub.paystack_subscription_code);
    if (!psSub?.email_token)
      return res.status(500).json({ error: "Could not retrieve subscription token from Paystack." });

    await paystack.disableSubscription(sub.paystack_subscription_code, psSub.email_token);

    /* Update DB immediately (webhook will also fire, but this ensures instant UX) */
    await Promise.all([
      supabase.from("subscriptions").update({ status: "canceled" }).eq("user_id", userId),
      supabase.from("users").update({ plan_tier: "free" }).eq("id", userId)
    ]);
    botManager.downgradeUserBots(userId);

    logger.info({ userId }, "[billing] cancel — subscription disabled via API");
    return res.json({ ok: true, message: "Subscription cancelled successfully." });
  } catch (err) {
    logger.error({ err: err.message }, "[billing/cancel] error");
    return res.status(500).json({ error: "Could not cancel subscription. Please try again or contact support." });
  }
});

/* ── POST /api/billing/webhook ───────────────────────────────── */
/* Paystack sends JSON payloads signed with HMAC-SHA512.          */
billingRouter.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    /* Verify Paystack signature if webhook secret is configured (strongly recommended) */
    if (env.paystackWebhookSecret) {
      const hash = crypto
        .createHmac("sha512", env.paystackWebhookSecret)
        .update(req.body)
        .digest("hex");
      if (hash !== req.headers["x-paystack-signature"]) {
        logger.warn("[billing/webhook] invalid Paystack signature — rejected");
        return res.status(400).json({ error: "Invalid webhook signature." });
      }
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON payload." });
    }

    logger.info({ type: event.event }, "[billing/webhook] received");

    try {
      const data = event.data ?? {};

      /* ── charge.success ─────────────────────────────────────
         Fires on both initial subscription payment and renewals.
         Only process if this charge is tied to a plan/subscription. */
      if (event.event === "charge.success" && data.plan?.id) {
        const userId = data.metadata?.userId ?? data.metadata?.custom_fields
          ?.find?.((f) => f.variable_name === "userId")?.value;

        if (!userId) {
          logger.warn({ ref: data.reference }, "[billing/webhook] charge.success — missing userId in metadata");
        } else {
          const { data: user } = await supabase
            .from("users").select("plan_tier").eq("id", userId).single();

          const subscriptionCode = data.subscription_code ?? null;
          const customerCode     = data.customer?.customer_code ?? null;

          /* Compute next period end as 31 days from charge date */
          const paidAt    = data.paid_at ? new Date(data.paid_at) : new Date();
          const periodEnd = new Date(paidAt.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString();

          if (user?.plan_tier !== "paid") {
            /* First payment — activate Pro */
            await Promise.all([
              supabase.from("users").update({
                plan_tier:            "paid",
                messages_this_month:  0,
                billing_period_start: new Date().toISOString()
              }).eq("id", userId),
              supabase.from("subscriptions").upsert(
                {
                  user_id:                    userId,
                  paystack_customer_code:     customerCode,
                  paystack_subscription_code: subscriptionCode,
                  status:                     "active",
                  plan_tier:                  "paid",
                  current_period_end:         periodEnd
                },
                { onConflict: "user_id" }
              )
            ]);
            /* Push plan upgrade to all running bot instances */
            for (const inst of botManager.instances.values()) {
              if (inst.userId === userId) inst.updateConfig({ plan_tier: "paid" });
            }
            logger.info({ userId }, "[billing] charge.success — user upgraded to Pro");
          } else {
            /* Renewal — reset monthly message counter, refresh subscription details */
            const renewSub = {
              status:             "active",
              current_period_end: periodEnd
            };
            /* Update subscription/customer codes if Paystack provides them on renewal */
            if (subscriptionCode) renewSub.paystack_subscription_code = subscriptionCode;
            if (customerCode)     renewSub.paystack_customer_code     = customerCode;

            await Promise.all([
              supabase.from("users").update({
                messages_this_month:  0,
                billing_period_start: new Date().toISOString()
              }).eq("id", userId),
              supabase.from("subscriptions").update(renewSub).eq("user_id", userId)
            ]);
            logger.info({ userId }, "[billing] charge.success — renewal, monthly counter reset");
          }
        }
      }

      /* ── subscription.create → store subscription code ────── */
      /* Fires when Paystack creates a new subscription for a customer.
         We capture the subscription code here so /portal and /cancel work
         even if the charge.success metadata is missing.                  */
      if (event.event === "subscription.create") {
        const code      = data.subscription_code;
        const custCode  = data.customer?.customer_code ?? null;
        const email     = data.customer?.email ?? null;
        if (code && email) {
          const { data: userRow } = await supabase
            .from("users").select("id").eq("email", email).maybeSingle();
          if (userRow?.id) {
            await supabase.from("subscriptions").upsert(
              {
                user_id:                    userRow.id,
                paystack_subscription_code: code,
                paystack_customer_code:     custCode,
                status:                     "active",
                plan_tier:                  "paid"
              },
              { onConflict: "user_id" }
            );
            logger.info({ userId: userRow.id, code }, "[billing] subscription.create — code stored");
          }
        }
      }

      /* ── subscription.disable → downgrade immediately ─────── */
      if (event.event === "subscription.disable") {
        const code = data.subscription_code;
        const { data: subRow } = await supabase
          .from("subscriptions").select("user_id")
          .eq("paystack_subscription_code", code).maybeSingle();

        if (subRow?.user_id) {
          await Promise.all([
            supabase.from("subscriptions").update({ status: "canceled" })
              .eq("paystack_subscription_code", code),
            supabase.from("users").update({ plan_tier: "free" }).eq("id", subRow.user_id)
          ]);
          botManager.downgradeUserBots(subRow.user_id);
          logger.info({ userId: subRow.user_id }, "[billing] subscription.disable — user downgraded to free");
        }
      }

      /* ── subscription.not_renew → mark canceled, keep access until period end */
      if (event.event === "subscription.not_renew") {
        const code = data.subscription_code;
        const { data: subRow } = await supabase
          .from("subscriptions").select("user_id")
          .eq("paystack_subscription_code", code).maybeSingle();

        if (subRow?.user_id) {
          /* Mark as canceled but do NOT downgrade yet — user keeps access until period end */
          await supabase.from("subscriptions").update({ status: "canceled" })
            .eq("paystack_subscription_code", code);
          logger.info({ userId: subRow.user_id }, "[billing] subscription.not_renew — marked canceled, access until period end");
        }
      }

      /* ── invoice.payment_failed → downgrade immediately ────── */
      if (event.event === "invoice.payment_failed") {
        const code = data.subscription?.subscription_code ?? data.subscription_code;
        if (code) {
          const { data: subRow } = await supabase
            .from("subscriptions").select("user_id")
            .eq("paystack_subscription_code", code).maybeSingle();
          if (subRow?.user_id) {
            await Promise.all([
              supabase.from("users").update({ plan_tier: "free" }).eq("id", subRow.user_id),
              supabase.from("subscriptions").update({ status: "past_due" })
                .eq("paystack_subscription_code", code)
            ]);
            botManager.downgradeUserBots(subRow.user_id);
            logger.info({ userId: subRow.user_id }, "[billing] invoice.payment_failed — user downgraded to free");
          }
        }
      }

    } catch (err) {
      logger.error({ err: err.message }, "[billing/webhook] unhandled error");
    }

    return res.json({ received: true });
  }
);

export default billingRouter;
