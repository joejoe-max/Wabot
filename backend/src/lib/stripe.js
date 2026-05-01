import Stripe from "stripe";
import { env } from "../config/env.js";

let _stripe = null;

function getStripe() {
  if (_stripe) return _stripe;
  if (!env.stripeSecretKey) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.");
  }
  _stripe = new Stripe(env.stripeSecretKey);
  return _stripe;
}

export const stripe = new Proxy({}, {
  get(_, prop) {
    return getStripe()[prop];
  }
});
